from ecu_lab.model import EscState, VehicleInputs


def test_synthetic_slip_triggers_and_then_releases_intervention() -> None:
    state = EscState()

    for _ in range(30):
        state.step(0.02, 0.6)
    assert state.intervention_active
    assert state.brake_pressure_bar > 0

    for _ in range(80):
        state.step(0.02, 1.1)
    assert not state.intervention_active
    assert state.brake_pressure_bar < 1


def test_vehicle_model_accelerates_brakes_and_turns() -> None:
    state = EscState(vehicle_speed_kph=0.0, wheel_speeds_kph=[0.0] * 4)
    for _ in range(100):
        state.drive(0.02, VehicleInputs(throttle_pct=70, steering_deg=12))

    accelerated_speed = state.vehicle_speed_kph
    assert accelerated_speed > 5
    assert state.yaw_rate_dps > 0
    assert state.lateral_g > 0

    for _ in range(80):
        state.drive(0.02, VehicleInputs(brake_pct=100))
    assert state.vehicle_speed_kph < accelerated_speed


def test_split_grip_wheel_fault_triggers_esc() -> None:
    state = EscState()
    for _ in range(25):
        state.drive(0.02, VehicleInputs(throttle_pct=18), wheel_fault_active=True)
    assert state.intervention_active
    assert state.wheel_speeds_kph[2] < state.wheel_speeds_kph[3] - 4

