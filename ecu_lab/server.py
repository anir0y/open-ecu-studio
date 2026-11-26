from __future__ import annotations

import argparse
import asyncio
import os
import subprocess
import threading
import time
from collections import deque
from dataclasses import asdict
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

import can
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .body import BODY_STATUS_ID, FOB_RECEIPT_ID, BodyAction, BodyState
from .bus import open_lab_bus, require_vcan
from .esc_capture import CaptureAction, EscCapture
from .model import EscState, VehicleInputs
from .protocol import (
    DYNAMICS_ID,
    ESC_STATUS_ID,
    FD_TELEMETRY_ID,
    UDS_REQUEST_ID,
    UDS_RESPONSE_ID,
    VEHICLE_STATE_ID,
    WHEEL_SPEED_ID,
    SyntheticUdsServer,
    decode_isotp_single_frame,
    dynamics_payload,
    encode_isotp_single_frame,
    esc_status_payload,
    fd_telemetry_payload,
    vehicle_state_payload,
    wheel_speed_payload,
)


class StartRequest(BaseModel):
    source: str = "synthetic"


class FaultRequest(BaseModel):
    active: bool


class CaptureRequest(BaseModel):
    action: CaptureAction


class DiagnosticRequest(BaseModel):
    service: str


class BodyRequest(BaseModel):
    action: BodyAction


class VehicleInputRequest(BaseModel):
    throttle_pct: float = 18.0
    brake_pct: float = 0.0
    steering_deg: float = 0.0
    road_grip: float = 0.92


class LabRuntime:
    def __init__(self, interface: str, channel: str) -> None:
        self.interface = interface
        self.channel = channel
        self._monitor_bus = self._open_bus()
        self._lifecycle = threading.Lock()
        self._firmware_error: str | None = None
        self._monitor_stop = threading.Event()
        self._producer_stop = threading.Event()
        self._monitor_thread = threading.Thread(target=self._monitor, daemon=True)
        self._producer_thread: threading.Thread | None = None
        self._firmware_process: subprocess.Popen[str] | None = None
        self._lock = threading.Lock()
        self._sequence = 0
        self._trace: deque[dict[str, Any]] = deque(maxlen=3000)
        self._frame_times: deque[float] = deque(maxlen=2000)
        self._source = "idle"
        self._fault_active = False
        self._esc_capture = EscCapture()
        self._body = BodyState()
        self._body_frames: dict[str, dict[str, Any]] = {}
        self._vehicle_inputs = VehicleInputs()
        self._vehicle: dict[str, float] = EscState().vehicle_snapshot()
        self._decoded: dict[str, Any] = {
            "wheel_speeds_kph": [0.0, 0.0, 0.0, 0.0],
            "yaw_rate_dps": 0.0,
            "steering_angle_deg": 0.0,
            "brake_pressure_bar": 0.0,
            "intervention_active": False,
            "sample_counter": 0,
        }
        self._monitor_thread.start()

    def _open_bus(self) -> can.BusABC:
        return open_lab_bus(self.interface, self.channel)

    def _monitor(self) -> None:
        while not self._monitor_stop.is_set():
            message = self._monitor_bus.recv(timeout=0.10)
            if message is None:
                continue
            now = time.time()
            with self._lock:
                self._sequence += 1
                record = {
                    "sequence": self._sequence,
                    "timestamp": now,
                    "id": f"0x{message.arbitration_id:03X}",
                    "arbitration_id": message.arbitration_id,
                    "data": bytes(message.data).hex().upper(),
                    "dlc": message.dlc,
                    "is_fd": message.is_fd,
                    "is_extended_id": message.is_extended_id,
                    "bitrate_switch": message.bitrate_switch,
                    "direction": (
                        "request" if message.arbitration_id == UDS_REQUEST_ID else "bus"
                    ),
                }
                if message.arbitration_id == UDS_RESPONSE_ID:
                    record["direction"] = "response"
                self._trace.append(record)
                if (not message.is_fd and not message.is_extended_id and not message.is_remote_frame
                        and not message.is_error_frame and message.dlc == len(message.data) == 8):
                    self._esc_capture.observe(record, message.timestamp)
                if message.arbitration_id in (BODY_STATUS_ID, FOB_RECEIPT_ID):
                    self._body_frames[record["id"]] = record
                self._frame_times.append(now)
                self._decode(message)

    def _decode(self, message: can.Message) -> None:
        data = bytes(message.data)
        if message.arbitration_id == WHEEL_SPEED_ID and len(data) >= 8:
            self._decoded["wheel_speeds_kph"] = [
                int.from_bytes(data[index : index + 2], "big") / 100
                for index in range(0, 8, 2)
            ]
        elif message.arbitration_id == DYNAMICS_ID and len(data) >= 8:
            self._decoded.update(
                yaw_rate_dps=int.from_bytes(data[0:2], "big", signed=True) / 100,
                steering_angle_deg=int.from_bytes(data[2:4], "big", signed=True) / 10,
                brake_pressure_bar=int.from_bytes(data[4:6], "big") / 10,
                intervention_active=bool(data[6] & 1),
                sample_counter=data[7],
            )
        elif message.arbitration_id == VEHICLE_STATE_ID and len(data) >= 8:
            self._decoded.update(
                vehicle_speed_kph=int.from_bytes(data[0:2], "big") / 100,
                acceleration_mps2=int.from_bytes(data[2:4], "big", signed=True)
                / 100,
                throttle_pct=data[4],
                driver_brake_pct=data[5],
                road_grip=data[6] / 100,
                lateral_g=int.from_bytes(data[7:8], "big", signed=True) / 100,
            )
        elif message.arbitration_id == ESC_STATUS_ID and len(data) >= 4:
            self._decoded["firmware_version"] = f"{data[0]}.{data[1]}"

    def _synthetic_producer(self) -> None:
        bus = self._open_bus()
        state = EscState()
        uds = SyntheticUdsServer()
        started = time.monotonic()
        next_classic = 0.0
        next_status = 0.0
        next_fd = 0.0
        try:
            while not self._producer_stop.is_set():
                elapsed = time.monotonic() - started
                with self._lock:
                    controls = VehicleInputs(**vars(self._vehicle_inputs))
                    fault_active = self._fault_active
                state.drive(0.02, controls, wheel_fault_active=fault_active)
                with self._lock:
                    self._vehicle = state.vehicle_snapshot()
                if elapsed >= next_classic:
                    bus.send(
                        can.Message(
                            arbitration_id=WHEEL_SPEED_ID,
                            data=wheel_speed_payload(state),
                            is_extended_id=False,
                        )
                    )
                    bus.send(
                        can.Message(
                            arbitration_id=DYNAMICS_ID,
                            data=dynamics_payload(state),
                            is_extended_id=False,
                        )
                    )
                    bus.send(
                        can.Message(
                            arbitration_id=VEHICLE_STATE_ID,
                            data=vehicle_state_payload(state),
                            is_extended_id=False,
                        )
                    )
                    next_classic += 0.05
                if elapsed >= next_status:
                    bus.send(
                        can.Message(
                            arbitration_id=ESC_STATUS_ID,
                            data=esc_status_payload(state),
                            is_extended_id=False,
                        )
                    )
                    next_status += 0.20
                if elapsed >= next_fd:
                    bus.send(
                        can.Message(
                            arbitration_id=FD_TELEMETRY_ID,
                            data=fd_telemetry_payload(state, round(elapsed * 1000)),
                            is_extended_id=False,
                            is_fd=True,
                            bitrate_switch=True,
                        )
                    )
                    next_fd += 0.10

                request = bus.recv(timeout=0.005)
                if request is not None and request.arbitration_id == UDS_REQUEST_ID:
                    bus.send(
                        can.Message(
                            arbitration_id=UDS_RESPONSE_ID,
                            data=uds.handle(bytes(request.data), state),
                            is_extended_id=False,
                        )
                    )
                time.sleep(0.015)
        finally:
            bus.shutdown()

    def _virtual_firmware(self) -> None:
        try:
            from .reference_board import ReferenceBoard

            with self._open_bus() as bus:
                ReferenceBoard(bus).run(self._producer_stop)
        except Exception as error:
            with self._lock:
                self._firmware_error = f"STM32 firmware execution failed: {type(error).__name__}: {error}"
                self._source = "idle"
                self._esc_capture.end_run()

    def _start_renode(self) -> None:
        require_vcan(self.channel)
        renode = os.environ.get("RENODE_PATH", "/opt/renode/renode")
        script = f'$canInterface="{self.channel}"; include @reference_ecu.resc; sleep 86400'
        self._firmware_process = subprocess.Popen(
            [renode, "--disable-xwt", "--plain", "-P", "-1", "-e", script],
            cwd=Path(__file__).resolve().parents[1] / "firmware/reference_ecu",
            stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT, text=True,
        )

    def _start_firmware(self) -> None:
        # A fresh listener prevents a previous run's queued frames from marking
        # the next boot ready. The version beacon comes from the compiled image.
        with self._open_bus() as listener:
            listener.set_filters([{"can_id": ESC_STATUS_ID, "can_mask": 0x7FF, "extended": False}])
            if self.interface == "virtual":
                self._producer_thread = threading.Thread(target=self._virtual_firmware, daemon=True)
                self._producer_thread.start()
            else:
                self._start_renode()
            deadline = time.monotonic() + 8.0
            while time.monotonic() < deadline:
                if self._firmware_process and self._firmware_process.poll() is not None:
                    raise RuntimeError("Renode exited before the STM32 sent its first status frame")
                with self._lock:
                    if self._firmware_error:
                        raise RuntimeError(self._firmware_error)
                message = listener.recv(timeout=0.05)
                if message is not None and len(message.data) == 8 and message.data[:2] == b"\x01\x00":
                    return
            raise RuntimeError("STM32 boot timed out waiting for its CAN status frame")

    def start(self, source: str) -> dict[str, Any]:
        if source not in {"synthetic", "firmware"}:
            raise ValueError("source must be synthetic or firmware")
        with self._lifecycle:
            self._stop_producers()
            self._producer_stop.clear()
            with self._lock:
                self._firmware_error = None
                self._esc_capture.start_run(source, time.time())
            if source == "synthetic":
                self._producer_thread = threading.Thread(target=self._synthetic_producer, daemon=True)
                self._producer_thread.start()
            else:
                try:
                    self._start_firmware()
                except (RuntimeError, OSError, ValueError) as error:
                    self._stop_producers()
                    with self._lock:
                        self._firmware_error = str(error)
                    raise RuntimeError(str(error)) from error
            with self._lock:
                if self._firmware_error:
                    raise RuntimeError(self._firmware_error)
                self._source = source
            return self.status()

    def stop(self) -> dict[str, Any]:
        with self._lifecycle:
            self._stop_producers()
            return self.status()

    def _stop_producers(self) -> None:
        self._producer_stop.set()
        if self._producer_thread is not None:
            self._producer_thread.join(timeout=2.0)
            self._producer_thread = None
        if self._firmware_process is not None:
            self._firmware_process.terminate()
            try:
                self._firmware_process.wait(timeout=3.0)
            except subprocess.TimeoutExpired:
                self._firmware_process.kill()
                self._firmware_process.wait(timeout=1.0)
            self._firmware_process = None
        with self._lock:
            self._source = "idle"
            self._esc_capture.end_run()

    def control_esc_capture(self, action: CaptureAction) -> dict[str, Any]:
        with self._lock:
            self._esc_capture.control(action, time.time())
        return self.status()

    def set_fault(self, active: bool) -> dict[str, Any]:
        with self._lock:
            self._fault_active = active
        return self.status()

    def body_action(self, action: BodyAction) -> dict[str, Any]:
        with self._lock:
            if self.interface != "virtual" or self._source == "firmware":
                raise ValueError("Body controls use the in-process virtual bus and dynamics model.")
            next_state, frames = self._body.apply(action)
            with self._open_bus() as sender:
                for identifier, data in frames:
                    sender.send(can.Message(arbitration_id=identifier, data=data, is_extended_id=False))
            self._body = next_state
        return self.status()

    def set_vehicle_inputs(self, request: VehicleInputRequest) -> dict[str, Any]:
        controls = VehicleInputs(
            throttle_pct=request.throttle_pct,
            brake_pct=request.brake_pct,
            steering_deg=request.steering_deg,
            road_grip=request.road_grip,
        ).clamped()
        with self._lock:
            self._vehicle_inputs = controls
        return self.status()

    def diagnostic(self, service: str) -> dict[str, Any]:
        payloads = {
            "extended_session": bytes([0x10, 0x03]),
            "tester_present": bytes([0x3E, 0x00]),
            "software_version": bytes([0x22, 0xF1, 0xA0]),
            "esc_state": bytes([0x22, 0xF1, 0xA1]),
        }
        if service not in payloads:
            raise ValueError("unknown diagnostic service")
        with self._lifecycle, self._open_bus() as bus:
            bus.set_filters([{"can_id": UDS_RESPONSE_ID, "can_mask": 0x7FF, "extended": False}])
            bus.send(
                can.Message(
                    arbitration_id=UDS_REQUEST_ID,
                    data=encode_isotp_single_frame(payloads[service]),
                    is_extended_id=False,
                )
            )
            deadline = time.monotonic() + 1.5
            while time.monotonic() < deadline:
                response = bus.recv(timeout=0.1)
                if response is not None and response.arbitration_id == UDS_RESPONSE_ID:
                    decoded = decode_isotp_single_frame(bytes(response.data))
                    return {
                        "service": service,
                        "request": payloads[service].hex().upper(),
                        "response": decoded.hex().upper(),
                        "positive": decoded[0] != 0x7F,
                    }
        raise TimeoutError("diagnostic response timed out")

    def status(self) -> dict[str, Any]:
        now = time.time()
        with self._lock:
            while self._frame_times and self._frame_times[0] < now - 1.0:
                self._frame_times.popleft()
            if self._source == "firmware" and self._firmware_process:
                code = self._firmware_process.poll()
                if code is not None:
                    self._firmware_error = f"Renode exited with code {code}"
                    self._source = "idle"
                    self._esc_capture.end_run()
            return {
                "interface": self.interface,
                "channel": self.channel,
                "source": self._source,
                "running": self._source != "idle",
                "firmware_running": self._source == "firmware",
                "firmware_error": self._firmware_error,
                "fault_active": self._fault_active,
                "esc_capture": self._esc_capture.snapshot(),
                "frame_count": self._sequence,
                "frames_per_second": len(self._frame_times),
                "decoded": dict(self._decoded),
                "vehicle": dict(self._vehicle),
                "vehicle_inputs": vars(self._vehicle_inputs).copy(),
                "body": asdict(self._body),
                "body_frames": self._body_frames.copy(),
            }

    def frames_since(self, sequence: int) -> list[dict[str, Any]]:
        with self._lock:
            return [frame for frame in self._trace if frame["sequence"] > sequence]

    def trace(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._trace)

    def close(self) -> None:
        self.stop()
        self._monitor_stop.set()
        self._monitor_thread.join(timeout=2.0)
        self._monitor_bus.shutdown()


def create_app(interface: str = "virtual", channel: str = "ecu-ui") -> FastAPI:
    runtime: LabRuntime | None = None

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        nonlocal runtime
        runtime = LabRuntime(interface, channel)
        yield
        runtime.close()

    app = FastAPI(title="Open ECU Research Console", lifespan=lifespan)

    def get_runtime() -> LabRuntime:
        if runtime is None:
            raise RuntimeError("lab runtime is not started")
        return runtime

    @app.get("/api/status")
    def status() -> dict[str, Any]:
        return get_runtime().status()

    @app.post("/api/run")
    def run(request: StartRequest) -> dict[str, Any]:
        try:
            return get_runtime().start(request.source)
        except (RuntimeError, ValueError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @app.post("/api/stop")
    def stop() -> dict[str, Any]:
        return get_runtime().stop()

    @app.post("/api/fault")
    def fault(request: FaultRequest) -> dict[str, Any]:
        return get_runtime().set_fault(request.active)

    @app.post("/api/esc-capture")
    def esc_capture(request: CaptureRequest) -> dict[str, Any]:
        return get_runtime().control_esc_capture(request.action)

    @app.post("/api/vehicle")
    def vehicle(request: VehicleInputRequest) -> dict[str, Any]:
        return get_runtime().set_vehicle_inputs(request)

    @app.post("/api/body")
    def body(request: BodyRequest) -> dict[str, Any]:
        try:
            return get_runtime().body_action(request.action)
        except ValueError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.post("/api/diagnostics")
    def diagnostics(request: DiagnosticRequest) -> dict[str, Any]:
        try:
            return get_runtime().diagnostic(request.service)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except TimeoutError as error:
            raise HTTPException(status_code=504, detail=str(error)) from error

    @app.get("/api/trace")
    def trace() -> JSONResponse:
        return JSONResponse(get_runtime().trace())

    @app.websocket("/ws")
    async def websocket(websocket: WebSocket) -> None:
        await websocket.accept()
        sequence = 0
        try:
            while True:
                frames = get_runtime().frames_since(sequence)
                if frames:
                    sequence = frames[-1]["sequence"]
                    await websocket.send_json(
                        {"frames": frames[-100:], "status": get_runtime().status()}
                    )
                else:
                    await websocket.send_json(
                        {"frames": [], "status": get_runtime().status()}
                    )
                await asyncio.sleep(0.10)
        except WebSocketDisconnect:
            return

    ui_dir = Path(__file__).with_name("ui_dist")
    if ui_dir.is_dir():
        assets = ui_dir / "assets"
        if assets.is_dir():
            app.mount("/assets", StaticFiles(directory=assets), name="assets")

        @app.get("/{path:path}")
        def frontend(path: str) -> FileResponse:
            requested = ui_dir / path
            if path and requested.is_file():
                return FileResponse(requested)
            return FileResponse(ui_dir / "index.html")
    else:

        @app.get("/")
        def missing_frontend() -> JSONResponse:
            return JSONResponse(
                {"detail": "UI is not built; run pnpm --dir ui build"},
                status_code=503,
            )

    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the ECU research console")
    parser.add_argument("--interface", choices=("virtual", "socketcan"), default="virtual")
    parser.add_argument("--channel", default="ecu-ui")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    import uvicorn

    uvicorn.run(
        create_app(args.interface, args.channel), host=args.host, port=args.port
    )


if __name__ == "__main__":
    main()
