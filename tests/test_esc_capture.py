import struct
import time

import pytest
from fastapi.testclient import TestClient

from ecu_lab.esc_capture import EscCapture
from ecu_lab.protocol import WHEEL_SPEED_ID, DYNAMICS_ID, ESC_STATUS_ID
from ecu_lab.server import create_app


def wheel(sequence, fl=4000, rl=4000, fr=4000):
    return dict(sequence=sequence, arbitration_id=WHEEL_SPEED_ID,
                data=struct.pack(">4H", fl, fr, rl, fr).hex().upper())


def report(sequence, identifier, raw):
    return dict(sequence=sequence, arbitration_id=identifier, data=raw)


def test_first_slip_uses_the_onset_dynamics_and_slower_esc_beacon():
    capture = EscCapture()
    capture.start_run("synthetic", 100)
    capture.control("arm", 100)
    normal = wheel(1, fl=3400, rl=3400, fr=4600)  # Normal side-to-side difference on a turn.
    capture.observe(normal, 101)
    capture.observe(wheel(2, rl=3601), 102)
    first = wheel(3, rl=3600)  # Exactly 4.00 km/h below FL.
    capture.observe(first, 103)
    dynamics = report(4, DYNAMICS_ID, "00000000012C01FF")
    capture.observe(dynamics, 104)
    collecting = capture.snapshot()
    assert collecting["state"] == "collecting"
    assert collecting["event"]["baseline"] == wheel(2, rl=3601)
    assert collecting["event"]["esc"] is None
    capture.observe(wheel(5, rl=3000), 105)
    capture.observe(report(6, DYNAMICS_ID, "0000000002580100"), 106)
    esc = report(7, ESC_STATUS_ID, "0100010000000000")
    capture.observe(esc, 107)
    snapshot = capture.snapshot()
    assert snapshot == {"state": "frozen", "complete": True, "event": {
        "source": "synthetic", "baseline": wheel(2, rl=3601),
        "wheels": first, "dynamics": dynamics, "esc": esc,
    }}
    capture.end_run()
    capture.start_run("firmware", 108)
    capture.observe(wheel(8), 109)
    assert capture.snapshot() == snapshot
    assert collecting["event"]["esc"] is None


def test_arming_mid_slip_waits_for_a_new_episode_and_never_pairs_across_runs():
    capture = EscCapture()
    capture.start_run("firmware", 10)
    capture.observe(wheel(1), 11)
    capture.control("arm", 15)
    capture.observe(wheel(2, rl=3000), 14)  # Queued before arming.
    capture.observe(wheel(3, rl=3000), 16)
    assert capture.snapshot()["state"] == "armed"
    capture.end_run()
    capture.start_run("synthetic", 20)
    capture.observe(wheel(4), 19)  # Previous source's queued baseline.
    capture.observe(wheel(5, rl=3000), 21)
    assert capture.snapshot()["event"] is None
    capture.observe(wheel(6), 22)
    capture.observe(wheel(7, rl=3000), 23)
    capture.observe(wheel(8, rl=3100), 24)
    capture.observe(report(9, DYNAMICS_ID, "0000000002580110"), 25)  # Belongs to wheel #8.
    capture.observe(wheel(10), 26)  # End of slip before the active status was observed.
    capture.observe(report(11, ESC_STATUS_ID, "0100011000000000"), 27)
    assert capture.snapshot() == {"state": "frozen", "complete": False, "event": {
        "source": "synthetic", "baseline": wheel(6), "wheels": wheel(7, rl=3000),
        "dynamics": None, "esc": None,
    }}
    capture.control("clear", 28)
    assert capture.snapshot() == {"state": "idle", "event": None, "complete": False}


@pytest.mark.parametrize("source", ["synthetic", "firmware"])
def test_live_event_is_made_of_actual_trace_packets_and_survives_stop(source):
    with TestClient(create_app("virtual", f"freeze-test-{source}")) as client:
        assert client.post("/api/esc-capture", json={"action": "arm"}).json()["esc_capture"]["state"] == "armed"
        assert client.post("/api/run", json={"source": source}).status_code == 200
        if source == "synthetic":
            deadline = time.monotonic() + 3
            while not any(frame["id"] == "0x181" for frame in client.get("/api/trace").json()):
                assert time.monotonic() < deadline
                time.sleep(0.01)
            client.post("/api/fault", json={"active": True}).raise_for_status()
        deadline = time.monotonic() + 6
        while True:
            capture = client.get("/api/status").json()["esc_capture"]
            if capture["state"] == "frozen":
                break
            assert time.monotonic() < deadline
            time.sleep(0.02)
        assert capture["complete"]
        event = capture["event"]
        assert event["source"] == source
        trace = client.get("/api/trace").json()
        frames = [event[name] for name in ("baseline", "wheels", "dynamics", "esc")]
        assert [frame["id"] for frame in frames] == ["0x181", "0x181", "0x182", "0x280"]
        assert all(frame in trace for frame in frames)
        assert all(a["sequence"] < b["sequence"] for a, b in zip(frames, frames[1:]))
        if source == "firmware":
            assert event["wheels"]["data"] == "0FA00FA00BB80FA0"
            assert event["dynamics"]["data"][8:12] == "0258"
        assert client.post("/api/stop").json()["esc_capture"] == capture
        assert client.post("/api/esc-capture", json={"action": "clear"}).json()["esc_capture"]["event"] is None
