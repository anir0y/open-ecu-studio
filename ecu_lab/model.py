from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field


@dataclass
class VehicleInputs:
    """Normalized driver and road inputs for the software-only vehicle model."""

    throttle_pct: float = 18.0
    brake_pct: float = 0.0
    steering_deg: float = 0.0
    road_grip: float = 0.92

    def clamped(self) -> VehicleInputs:
        return VehicleInputs(
            throttle_pct=max(0.0, min(100.0, self.throttle_pct)),
            brake_pct=max(0.0, min(100.0, self.brake_pct)),
            steering_deg=max(-30.0, min(30.0, self.steering_deg)),
            road_grip=max(0.2, min(1.0, self.road_grip)),
        )


@dataclass
class EscState:
    """Deterministic bicycle-model vehicle with an ESC-like intervention layer.

    It is intentionally educational: useful for repeatable CAN behavior, but not
    a safety controller or a high-fidelity tire model.
    """

    wheel_speeds_kph: list[float] = field(
        default_factory=lambda: [40.0, 40.0, 40.0, 40.0]
    )
    vehicle_speed_kph: float = 40.0
    acceleration_mps2: float = 0.0
    yaw_rate_dps: float = 0.0
    steering_angle_deg: float = 0.0
    brake_pressure_bar: float = 0.0
    lateral_g: float = 0.0
    heading_deg: float = 0.0
    distance_m: float = 0.0
    throttle_pct: float = 18.0
    driver_brake_pct: float = 0.0
    road_grip: float = 0.92
    intervention_active: bool = False
    sample_counter: int = 0

    def drive(
        self,
        dt: float,
        inputs: VehicleInputs,
        wheel_fault_active: bool = False,
    ) -> None:
        if dt <= 0:
            raise ValueError("dt must be positive")

        controls = inputs.clamped()
        self.throttle_pct = controls.throttle_pct
        self.driver_brake_pct = controls.brake_pct
        self.road_grip = controls.road_grip

        speed_mps = self.vehicle_speed_kph / 3.6
        throttle_acceleration = controls.throttle_pct / 100.0 * 4.2 * controls.road_grip
        service_braking = controls.brake_pct / 100.0 * 9.0 * controls.road_grip
        drag = 0.10 + 0.004 * speed_mps * speed_mps
        if speed_mps <= 0.02 and throttle_acceleration <= service_braking + drag:
            longitudinal_acceleration = 0.0
        else:
            longitudinal_acceleration = throttle_acceleration - service_braking - drag

        speed_mps = max(0.0, min(70.0, speed_mps + longitudinal_acceleration * dt))
        self.vehicle_speed_kph = speed_mps * 3.6
        self.acceleration_mps2 = longitudinal_acceleration

        steering_response = min(1.0, 8.0 * dt)
        self.steering_angle_deg += (
            controls.steering_deg - self.steering_angle_deg
        ) * steering_response

        wheelbase_m = 2.68
        ideal_yaw_rad_s = (
            speed_mps / wheelbase_m * math.tan(math.radians(self.steering_angle_deg))
        )
        grip_limited_yaw = max(
            -1.35 * controls.road_grip,
            min(1.35 * controls.road_grip, ideal_yaw_rad_s),
        )
        ideal_yaw_dps = math.degrees(grip_limited_yaw)
        yaw_response = min(1.0, 4.5 * controls.road_grip * dt)
        self.yaw_rate_dps += (ideal_yaw_dps - self.yaw_rate_dps) * yaw_response
        self.heading_deg = (self.heading_deg + self.yaw_rate_dps * dt) % 360.0
        self.lateral_g = speed_mps * math.radians(self.yaw_rate_dps) / 9.81
        self.distance_m += speed_mps * dt

        track_m = 1.58
        turn_delta_kph = math.radians(self.yaw_rate_dps) * track_m * 1.8
        targets = [
            max(0.0, self.vehicle_speed_kph - turn_delta_kph),
            max(0.0, self.vehicle_speed_kph + turn_delta_kph),
            max(0.0, self.vehicle_speed_kph - turn_delta_kph),
            max(0.0, self.vehicle_speed_kph + turn_delta_kph),
        ]
        if wheel_fault_active:
            targets[2] *= 0.70

        wheel_response = min(1.0, 12.0 * dt)
        for index, target_speed in enumerate(targets):
            self.wheel_speeds_kph[index] += (
                target_speed - self.wheel_speeds_kph[index]
            ) * wheel_response

        wheel_spread = max(self.wheel_speeds_kph) - min(self.wheel_speeds_kph)
        yaw_error = abs(ideal_yaw_dps - self.yaw_rate_dps)
        self.intervention_active = wheel_spread >= 4.0 or yaw_error >= 12.0
        target_pressure = 0.0
        if self.intervention_active:
            target_pressure = min(90.0, wheel_spread * 7.0 + yaw_error * 1.5)
            self.yaw_rate_dps *= max(0.0, 1.0 - 0.9 * dt)

        pressure_response = min(1.0, (14.0 if target_pressure else 6.0) * dt)
        self.brake_pressure_bar += (
            target_pressure - self.brake_pressure_bar
        ) * pressure_response
        self.sample_counter = (self.sample_counter + 1) & 0xFF

    def step(self, dt: float, elapsed: float) -> None:
        """Compatibility scenario used by the original deterministic demo."""

        fault_active = 0.4 <= elapsed < 1.0
        self.drive(
            dt,
            VehicleInputs(
                throttle_pct=5.5,
                steering_deg=7.5 if fault_active else 0.0,
                road_grip=0.92,
            ),
            wheel_fault_active=fault_active,
        )

    def vehicle_snapshot(self) -> dict[str, float]:
        snapshot = asdict(self)
        snapshot.pop("wheel_speeds_kph")
        snapshot.pop("intervention_active")
        snapshot.pop("sample_counter")
        return snapshot
