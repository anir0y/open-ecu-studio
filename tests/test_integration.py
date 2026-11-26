from ecu_lab.demo import run_demo


def test_virtual_network_demo() -> None:
    result = run_demo(duration=1.15, step_seconds=0.01)
    assert result["classic_frames_captured"] > 20
    assert result["can_fd_frames_captured"] > 5
    assert result["diagnostic_responses"] == [
        "5003003201F4",
        "7E00",
        "62F1A00100",
    ]
    assert result["esc_intervention_observed"] is True

