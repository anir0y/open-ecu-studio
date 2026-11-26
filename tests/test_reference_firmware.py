from fastapi.testclient import TestClient

from ecu_lab import reference_board
from ecu_lab.server import create_app


def test_compiled_reference_firmware_boots_and_resets_on_the_virtual_bus() -> None:
    with TestClient(create_app(channel="firmware-test")) as client:
        def diagnose(service: str) -> str:
            reply = client.post("/api/diagnostics", json={"service": service})
            assert reply.status_code == 200, reply.text
            return reply.json()["response"]

        for _ in range(2):
            boot = client.post("/api/run", json={"source": "firmware"})
            assert boot.status_code == 200, boot.text
            assert boot.json()["firmware_running"]
            assert diagnose("esc_state").endswith("01")
            assert diagnose("extended_session") == "5003003201F4"
            assert diagnose("software_version") == "62F1A00100"
            assert diagnose("tester_present") == "7E00"
            assert diagnose("esc_state").endswith("03")
            trace = client.get("/api/trace").json()
            assert {frame["id"] for frame in trace} == {"0x181", "0x182", "0x280", "0x6A0", "0x6A8"}
            assert all(not frame["is_fd"] and not frame["is_extended_id"] for frame in trace)
            assert client.post("/api/stop").json()["source"] == "idle"


def test_reference_boot_failure_returns_to_idle_and_allows_another_run(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(reference_board, "IMAGE", tmp_path / "missing.elf")
    with TestClient(create_app(channel="firmware-failure-test")) as client:
        boot = client.post("/api/run", json={"source": "firmware"})
        assert boot.status_code == 400
        status = client.get("/api/status").json()
        assert not status["running"] and not status["firmware_running"]
        assert "missing.elf" in status["firmware_error"]
        assert client.post("/api/run", json={"source": "synthetic"}).json()["firmware_error"] is None
