import time

import pytest
from fastapi.testclient import TestClient

from ecu_lab.body import BODY_STATUS_ID, FOB_RECEIPT_ID, BodyState
from ecu_lab.server import create_app


def test_cabin_controls_encode_separate_switches_and_observe_interlocks() -> None:
    state = BodyState()
    for revision, (action, lights, indicators, doors, wiper) in enumerate([
        ("low_beam", 1, 0, 0, 0),
        ("high_beam", 2, 0, 0, 0),
        ("signal_left", 2, 1, 0, 0),
        ("signal_right", 2, 2, 0, 0),
        ("hazards", 2, 3, 0, 0),
        ("open_left", 2, 3, 1, 0),
        ("open_right", 2, 3, 3, 0),
        ("close_left", 2, 3, 2, 0),
        ("wiper_on", 2, 3, 2, 1),
        ("close_right", 2, 3, 0, 1),
        ("signal_off", 2, 0, 0, 1),
        ("lights_off", 0, 0, 0, 1),
        ("wiper_off", 0, 0, 0, 0),
    ], start=1):
        state, frames = state.apply(action)
        assert frames == [(BODY_STATUS_ID, bytes([
            lights, indicators, doors, 0, wiper, int(doors != 0), 0, revision,
        ]))]
        if doors:
            with pytest.raises(ValueError, match="Close both doors"):
                state.apply("lock")
    locked, _ = state.apply("lock")
    for action in ("open_left", "open_right"):
        with pytest.raises(ValueError, match="Unlock"):
            locked.apply(action)
    unlocked, _ = locked.apply("unlock")
    assert not unlocked.locked


def test_receiver_consumes_fresh_event_even_when_a_door_is_open() -> None:
    state, _ = BodyState().apply("open_right")
    state, frames = state.apply("fob_lock")
    assert frames == [(FOB_RECEIPT_ID, bytes.fromhex("03 01 00 00 00 01 00 01"))]
    state, _ = state.apply("close_right")
    state, frames = state.apply("check_duplicate")
    assert frames == [(FOB_RECEIPT_ID, bytes.fromhex("02 01 00 00 00 01 00 02"))]
    assert not state.locked
    state, frames = state.apply("fob_lock")
    assert state.locked
    assert frames == [
        (FOB_RECEIPT_ID, bytes.fromhex("01 01 00 00 00 02 01 03")),
        (BODY_STATUS_ID, bytes.fromhex("00 00 00 01 00 00 01 03")),
    ]


def test_parked_car_publishes_fob_decisions_and_body_status_on_virtual_can() -> None:
    with TestClient(create_app(channel="body-publication-test")) as client:
        assert client.post("/api/body", json={"action": "check_duplicate"}).status_code == 409
        for action in ("lock", "fob_unlock", "lock", "check_duplicate"):
            response = client.post("/api/body", json={"action": action})
            assert response.status_code == 200
        state = response.json()["body"]
        assert state["locked"] and state["decision"] == "duplicate"
        assert state["receiver_counter"] == 1 and state["revision"] == 3
        expected = [
            ("0x361", "0000000100000001"),
            ("0x362", "0100000000010002"),
            ("0x361", "0000000000000102"),
            ("0x361", "0000000100000003"),
            ("0x362", "0200000000010103"),
        ]
        deadline = time.monotonic() + 2
        while True:
            trace = client.get("/api/trace").json()
            if len(trace) >= len(expected) or time.monotonic() >= deadline:
                break
            time.sleep(0.01)
        assert [(packet["id"], packet["data"]) for packet in trace] == expected
        assert all(packet["dlc"] == 8 and not packet["is_fd"] and not packet["is_extended_id"]
                   for packet in trace)
        assert client.get("/api/status").json()["body_frames"] == {
            "0x361": trace[-2], "0x362": trace[-1],
        }
