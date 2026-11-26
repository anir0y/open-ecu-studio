from __future__ import annotations

import struct
from dataclasses import dataclass

from .model import EscState


# These identifiers are invented for this lab and do not describe a real vehicle.
WHEEL_SPEED_ID = 0x181
DYNAMICS_ID = 0x182
VEHICLE_STATE_ID = 0x183
ESC_STATUS_ID = 0x280
FD_TELEMETRY_ID = 0x510
UDS_REQUEST_ID = 0x6A0
UDS_RESPONSE_ID = 0x6A8


def wheel_speed_payload(state: EscState) -> bytes:
    values = [round(speed * 100) for speed in state.wheel_speeds_kph]
    return struct.pack(">4H", *values)


def dynamics_payload(state: EscState) -> bytes:
    flags = 0x01 if state.intervention_active else 0x00
    return struct.pack(
        ">hhHBB",
        round(state.yaw_rate_dps * 100),
        round(state.steering_angle_deg * 10),
        round(state.brake_pressure_bar * 10),
        flags,
        state.sample_counter,
    )


def vehicle_state_payload(state: EscState) -> bytes:
    return struct.pack(
        ">HhBBBB",
        round(max(0.0, min(655.35, state.vehicle_speed_kph)) * 100),
        round(max(-327.68, min(327.67, state.acceleration_mps2)) * 100),
        round(state.throttle_pct),
        round(state.driver_brake_pct),
        round(state.road_grip * 100),
        round(max(-1.27, min(1.27, state.lateral_g)) * 100) & 0xFF,
    )


def esc_status_payload(state: EscState) -> bytes:
    return bytes(
        [
            1,  # synthetic software major
            0,  # synthetic software minor
            int(state.intervention_active),
            state.sample_counter,
            0,
            0,
            0,
            0,
        ]
    )


def fd_telemetry_payload(state: EscState, elapsed_ms: int) -> bytes:
    return struct.pack(
        ">I4HhBB",
        elapsed_ms,
        *(round(speed * 100) for speed in state.wheel_speeds_kph),
        round(state.yaw_rate_dps * 100),
        int(state.intervention_active),
        state.sample_counter,
    )


def encode_isotp_single_frame(payload: bytes) -> bytes:
    if not 1 <= len(payload) <= 7:
        raise ValueError("classic-CAN ISO-TP single frame payload must be 1..7 bytes")
    return bytes([len(payload)]) + payload + bytes(7 - len(payload))


def decode_isotp_single_frame(frame: bytes) -> bytes:
    if len(frame) != 8 or frame[0] >> 4 != 0:
        raise ValueError("expected an eight-byte ISO-TP single frame")
    length = frame[0] & 0x0F
    if not 1 <= length <= 7:
        raise ValueError("invalid ISO-TP single-frame length")
    return frame[1 : 1 + length]


@dataclass
class SyntheticUdsServer:
    session: int = 0x01

    def handle(self, frame: bytes, state: EscState) -> bytes:
        request = decode_isotp_single_frame(frame)
        service = request[0]

        if service == 0x10 and len(request) == 2 and request[1] in (0x01, 0x03):
            self.session = request[1]
            # Positive response plus synthetic P2/P2* timing values.
            response = bytes([0x50, self.session, 0x00, 0x32, 0x01, 0xF4])
        elif service == 0x3E and len(request) == 2:
            response = bytes([0x7E, request[1] & 0x7F])
        elif service == 0x22 and request == bytes([0x22, 0xF1, 0xA0]):
            response = bytes([0x62, 0xF1, 0xA0, 0x01, 0x00])
        elif service == 0x22 and request == bytes([0x22, 0xF1, 0xA1]):
            response = bytes(
                [0x62, 0xF1, 0xA1, int(state.intervention_active), self.session]
            )
        else:
            response = bytes([0x7F, service, 0x11])

        return encode_isotp_single_frame(response)

