"""Freeze the first observed rear-left slip in the classroom CAN stream."""

from typing import Any, Literal

from .protocol import WHEEL_SPEED_ID, DYNAMICS_ID, ESC_STATUS_ID

Frame = dict[str, Any]
CaptureAction = Literal["arm", "clear"]


def rear_left_slip(frame: Frame) -> bool:
    wheels = bytes.fromhex(frame["data"])
    # FL and RL normally track together in this model, even in a turn.
    # The model's intervention threshold is 4 km/h, or 400 raw units.
    return int.from_bytes(wheels[:2], "big") - int.from_bytes(wheels[4:6], "big") >= 400


class EscCapture:
    def __init__(self) -> None:
        self.state = "idle"
        self.event: dict[str, Any] | None = None
        self.source: str | None = None
        self._run_since = 0.0
        self._armed_since = 0.0
        self._last_wheel: Frame | None = None

    def start_run(self, source: str, now: float) -> None:
        self.end_run()
        self.source = source
        self._run_since = now

    def end_run(self) -> None:
        if self.state == "collecting":
            self.state = "frozen"
        self.source = None
        self._last_wheel = None

    def control(self, action: CaptureAction, now: float) -> None:
        self.state = "armed" if action == "arm" else "idle"
        self.event = None
        self._armed_since = now

    def observe(self, frame: Frame, sent_at: float) -> None:
        if self.source is None or sent_at < self._run_since:
            return
        identifier = frame["arbitration_id"]
        if identifier == WHEEL_SPEED_ID:
            previous = self._last_wheel
            self._last_wheel = frame
            slipping = rear_left_slip(frame)
            if self.state == "armed" and slipping and sent_at >= self._armed_since:
                if previous is not None and not rear_left_slip(previous):
                    self.event = dict(source=self.source, baseline=previous, wheels=frame, dynamics=None, esc=None)
                    self.state = "collecting"
            elif self.state == "collecting" and not slipping:
                self.state = "frozen"  # Keep the actual onset even if a report was missing.
            return

        event = self.event
        if self.state != "collecting" or event is None:
            return
        if identifier == DYNAMICS_ID and self._last_wheel is event["wheels"] and event["dynamics"] is None:
            # 0x181 carries no counter. Both lab sources emit it immediately before 0x182.
            self.event = {**event, "dynamics": frame}
        elif identifier == ESC_STATUS_ID and int(frame["data"][4:6], 16) & 1:
            # The status beacon is slower. Keep its own sequence, timestamp and counter.
            self.event = {**event, "esc": frame}
            self.state = "frozen"

    def snapshot(self) -> dict[str, Any]:
        event = self.event
        return {"state": self.state, "event": event,
                "complete": bool(event and event["dynamics"] and event["esc"])}
