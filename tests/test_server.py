import time

from fastapi.testclient import TestClient

from ecu_lab.server import create_app


def test_api_runs_synthetic_scenario_and_diagnostics() -> None:
    with TestClient(create_app(channel="api-test")) as client:
        start = client.post("/api/run", json={"source": "synthetic"})
        assert start.status_code == 200
        time.sleep(0.25)

        diagnostic = client.post(
            "/api/diagnostics", json={"service": "software_version"}
        )
        assert diagnostic.status_code == 200
        assert diagnostic.json()["response"] == "62F1A00100"

        status = client.get("/api/status").json()
        assert status["running"] is True
        assert status["frame_count"] > 0
        trace = client.get("/api/trace").json()
        assert trace
        assert all(frame["is_extended_id"] is False for frame in trace)

        controls = client.post(
            "/api/vehicle",
            json={
                "throttle_pct": 64,
                "brake_pct": 2,
                "steering_deg": -14,
                "road_grip": 0.7,
            },
        )
        assert controls.status_code == 200
        assert controls.json()["vehicle_inputs"]["steering_deg"] == -14

        stop = client.post("/api/stop")
        assert stop.status_code == 200
        assert stop.json()["running"] is False

