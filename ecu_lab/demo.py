from __future__ import annotations

import argparse
import json
import threading
import time
from collections import Counter
from pathlib import Path
from typing import Any

import can

from .bus import open_lab_bus
from .model import EscState
from .protocol import (
    DYNAMICS_ID,
    ESC_STATUS_ID,
    FD_TELEMETRY_ID,
    UDS_REQUEST_ID,
    UDS_RESPONSE_ID,
    WHEEL_SPEED_ID,
    SyntheticUdsServer,
    decode_isotp_single_frame,
    dynamics_payload,
    encode_isotp_single_frame,
    esc_status_payload,
    fd_telemetry_payload,
    wheel_speed_payload,
)


def _wait_for_id(bus: can.BusABC, arbitration_id: int, timeout: float) -> can.Message:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        message = bus.recv(timeout=max(0.0, deadline - time.monotonic()))
        if message is not None and message.arbitration_id == arbitration_id:
            return message
    raise TimeoutError(f"timed out waiting for CAN ID 0x{arbitration_id:03X}")


def run_demo(
    interface: str = "virtual",
    channel: str = "ecu-lab",
    duration: float = 1.4,
    step_seconds: float = 0.02,
) -> dict[str, Any]:
    if duration < 1.1:
        raise ValueError("duration must be at least 1.1 seconds")

    ecu_bus = open_lab_bus(interface, channel)
    tester_bus = open_lab_bus(interface, channel)
    monitor_bus = open_lab_bus(interface, channel)
    state = EscState()
    uds = SyntheticUdsServer()
    stop = threading.Event()
    captured: list[can.Message] = []
    capture_lock = threading.Lock()

    def ecu_receiver() -> None:
        while not stop.is_set():
            message = ecu_bus.recv(timeout=0.05)
            if message is None or message.arbitration_id != UDS_REQUEST_ID:
                continue
            response = uds.handle(bytes(message.data), state)
            ecu_bus.send(can.Message(arbitration_id=UDS_RESPONSE_ID, data=response))

    def monitor() -> None:
        while not stop.is_set():
            message = monitor_bus.recv(timeout=0.05)
            if message is not None:
                with capture_lock:
                    captured.append(message)

    receiver_thread = threading.Thread(target=ecu_receiver, daemon=True)
    monitor_thread = threading.Thread(target=monitor, daemon=True)
    receiver_thread.start()
    monitor_thread.start()

    diagnostic_responses: list[str] = []
    intervention_samples = 0
    started = time.monotonic()
    next_classic = 0.0
    next_status = 0.0
    next_fd = 0.0
    diagnostics_sent = False

    try:
        while True:
            now = time.monotonic()
            elapsed = now - started
            if elapsed >= duration:
                break

            state.step(step_seconds, elapsed)
            intervention_samples += int(state.intervention_active)

            if elapsed >= next_classic:
                ecu_bus.send(
                    can.Message(arbitration_id=WHEEL_SPEED_ID, data=wheel_speed_payload(state))
                )
                ecu_bus.send(
                    can.Message(arbitration_id=DYNAMICS_ID, data=dynamics_payload(state))
                )
                next_classic += 0.05

            if elapsed >= next_status:
                ecu_bus.send(
                    can.Message(arbitration_id=ESC_STATUS_ID, data=esc_status_payload(state))
                )
                next_status += 0.20

            if elapsed >= next_fd:
                ecu_bus.send(
                    can.Message(
                        arbitration_id=FD_TELEMETRY_ID,
                        data=fd_telemetry_payload(state, round(elapsed * 1000)),
                        is_fd=True,
                        bitrate_switch=True,
                    )
                )
                next_fd += 0.10

            if elapsed >= 0.20 and not diagnostics_sent:
                for payload in (
                    bytes([0x10, 0x03]),
                    bytes([0x3E, 0x00]),
                    bytes([0x22, 0xF1, 0xA0]),
                ):
                    tester_bus.send(
                        can.Message(
                            arbitration_id=UDS_REQUEST_ID,
                            data=encode_isotp_single_frame(payload),
                        )
                    )
                    response = _wait_for_id(tester_bus, UDS_RESPONSE_ID, timeout=0.5)
                    diagnostic_responses.append(
                        decode_isotp_single_frame(bytes(response.data)).hex().upper()
                    )
                diagnostics_sent = True

            time.sleep(step_seconds)
    finally:
        time.sleep(0.10)
        stop.set()
        receiver_thread.join(timeout=1.0)
        monitor_thread.join(timeout=1.0)
        ecu_bus.shutdown()
        tester_bus.shutdown()
        monitor_bus.shutdown()

    with capture_lock:
        frames = list(captured)
    counts = Counter(f"0x{message.arbitration_id:03X}" for message in frames)
    classic_frames = sum(not message.is_fd for message in frames)
    fd_frames = sum(message.is_fd for message in frames)

    return {
        "backend": interface,
        "channel": channel,
        "synthetic_ids": dict(sorted(counts.items())),
        "classic_frames_captured": classic_frames,
        "can_fd_frames_captured": fd_frames,
        "diagnostic_responses": diagnostic_responses,
        "esc_intervention_observed": intervention_samples > 0,
        "intervention_samples": intervention_samples,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--interface", choices=("virtual", "socketcan"), default="virtual")
    parser.add_argument("--channel", default="ecu-lab")
    parser.add_argument("--duration", type=float, default=1.4)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    result = run_demo(args.interface, args.channel, args.duration)
    rendered = json.dumps(result, indent=2, sort_keys=True)
    print(rendered)
    if args.output:
        args.output.write_text(rendered + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()

