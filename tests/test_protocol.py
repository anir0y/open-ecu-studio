import pytest

from ecu_lab.model import EscState
from ecu_lab.protocol import (
    SyntheticUdsServer,
    decode_isotp_single_frame,
    encode_isotp_single_frame,
    fd_telemetry_payload,
    vehicle_state_payload,
)


def test_single_frame_round_trip() -> None:
    payload = bytes([0x22, 0xF1, 0xA0])
    assert decode_isotp_single_frame(encode_isotp_single_frame(payload)) == payload


def test_single_frame_rejects_multiframe_payload() -> None:
    with pytest.raises(ValueError):
        encode_isotp_single_frame(bytes(8))


def test_uds_positive_and_negative_responses() -> None:
    server = SyntheticUdsServer()
    state = EscState()
    positive = server.handle(encode_isotp_single_frame(bytes([0x10, 0x03])), state)
    negative = server.handle(encode_isotp_single_frame(bytes([0x99])), state)
    assert decode_isotp_single_frame(positive)[:2] == bytes([0x50, 0x03])
    assert decode_isotp_single_frame(negative) == bytes([0x7F, 0x99, 0x11])


def test_fd_payload_is_sixteen_bytes() -> None:
    assert len(fd_telemetry_payload(EscState(), 123)) == 16


def test_vehicle_state_payload_is_classic_can_frame() -> None:
    assert len(vehicle_state_payload(EscState())) == 8

