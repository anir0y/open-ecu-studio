"""Execute the lab's STM32F407 image with a minimal UART and bxCAN mailbox model."""

import struct
import threading
from pathlib import Path

import can
from elftools.elf.elffile import ELFFile
from unicorn import UC_ARCH_ARM, UC_MODE_MCLASS, UC_MODE_THUMB, Uc
from unicorn.arm_const import UC_ARM_REG_PC, UC_ARM_REG_SP, UC_CPU_ARM_CORTEX_M4

from .protocol import UDS_REQUEST_ID


IMAGE = Path(__file__).resolve().parents[1] / "firmware/reference_ecu/build/reference_ecu.elf"
FLASH = 0x08000000
SRAM = 0x20000000
SRAM_SIZE = 128 * 1024
CAN_PAGE_OFFSET = 0x400  # CAN1 starts at 0x40006400 inside the mapped page.


class ReferenceBoard:
    def __init__(self, bus: can.BusABC) -> None:
        self.bus = bus
        bus.set_filters([{"can_id": UDS_REQUEST_ID, "can_mask": 0x7FF, "extended": False}])
        self.mailbox: dict[int, int] = {}
        self.rx: can.Message | None = None
        self.cpu = Uc(UC_ARCH_ARM, UC_MODE_THUMB | UC_MODE_MCLASS)
        self.cpu.ctl_set_cpu_model(UC_CPU_ARM_CORTEX_M4)
        self.cpu.mem_map(FLASH, 1024 * 1024)
        self.cpu.mem_map(SRAM, SRAM_SIZE)
        with IMAGE.open("rb") as binary:
            for segment in ELFFile(binary).iter_segments(type="PT_LOAD"):
                self.cpu.mem_write(segment["p_paddr"], segment.data())
        stack, self.entry = struct.unpack("<II", self.cpu.mem_read(FLASH, 8))
        if not SRAM < stack <= SRAM + SRAM_SIZE:
            raise ValueError("Reference firmware stack vector is outside STM32F407 main SRAM")
        self.cpu.reg_write(UC_ARM_REG_SP, stack)
        self.cpu.mem_map(0x40020000, 0x4000)  # GPIOA and RCC configuration registers.
        self.cpu.mem_map(0x40004000, 0x1000)
        self.cpu.mem_write(0x40004400, struct.pack("<I", 1 << 7))  # USART2 TX register empty.
        self.cpu.mmio_map(0x40006000, 0x1000, self._read_can, None, self._write_can, None)

    def _read_can(self, _cpu: Uc, offset: int, _size: int, _context: None) -> int:
        register = offset - CAN_PAGE_OFFSET
        if register == 0x04:  # MSR acknowledges the requested initialization mode.
            return self.mailbox.get(0, 0) & 1
        if register == 0x08:  # TSR, TX mailbox 0 empty.
            return 1 << 26
        if register == 0x0C:  # RF0R, pending words in RX FIFO 0.
            if self.rx is None:
                self.rx = self.bus.recv(timeout=0)
            return int(self.rx is not None)
        if self.rx is not None:
            if register == 0x1B0:
                return self.rx.arbitration_id << 21
            if register == 0x1B4:
                return self.rx.dlc
            if register in (0x1B8, 0x1BC):
                start = register - 0x1B8
                return int.from_bytes(self.rx.data[start:start + 4], "little")
        return self.mailbox.get(register, 0)

    def _write_can(self, _cpu: Uc, offset: int, _size: int, value: int, _context: None) -> None:
        register = offset - CAN_PAGE_OFFSET
        self.mailbox[register] = value
        if register == 0x0C and value & (1 << 5):
            self.rx = None  # Release FIFO 0 on the firmware's acknowledgement.
        if register == 0x180 and value & 1:
            payload = struct.pack("<II", self.mailbox[0x188], self.mailbox[0x18C])
            self.bus.send(can.Message(arbitration_id=(value >> 21) & 0x7FF,
                                      data=payload[:self.mailbox[0x184] & 0xF], is_extended_id=False))

    def run(self, stop: threading.Event) -> None:
        pc = self.entry
        while not stop.is_set():
            # Advance a bounded slice so stop and restart remain responsive.
            self.cpu.emu_start(pc | 1, 0, count=500_000)
            pc = self.cpu.reg_read(UC_ARM_REG_PC)
            stop.wait(0.01)
