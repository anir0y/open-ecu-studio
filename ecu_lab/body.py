"""Body-controller teaching model. Fob button presses are local application events."""

from dataclasses import dataclass, replace
from typing import Literal

BODY_STATUS_ID = 0x361
FOB_RECEIPT_ID = 0x362
BodyAction = Literal[
    "lights_off", "low_beam", "high_beam", "signal_off", "signal_left",
    "signal_right", "hazards", "wiper_off", "wiper_on", "open_left",
    "close_left", "open_right", "close_right", "lock", "unlock",
    "fob_lock", "fob_unlock", "check_duplicate",
]


@dataclass(frozen=True)
class BodyState:
    lights: int = 0
    signal: int = 0
    left_open: bool = False
    right_open: bool = False
    locked: bool = False
    wiper: bool = False
    revision: int = 0
    fob_counter: int = 0
    receiver_counter: int = 0
    fob_lock: bool = False
    decision: str = ""

    def status_payload(self, from_fob: bool) -> bytes:
        doors = int(self.left_open) | (int(self.right_open) << 1)
        return bytes((self.lights, self.signal, doors, self.locked, self.wiper,
                      bool(doors), from_fob, self.revision))

    def receipt_payload(self) -> bytes:
        decision = {"accepted": 1, "duplicate": 2, "door_open": 3}[self.decision]
        return (bytes((decision, self.fob_lock)) + self.fob_counter.to_bytes(4, "big")
                + bytes((self.locked, self.revision)))

    def apply(self, action: BodyAction) -> tuple["BodyState", list[tuple[int, bytes]]]:
        if action in ("fob_lock", "fob_unlock", "check_duplicate"):
            repeated = action == "check_duplicate"
            if repeated and not self.fob_counter:
                raise ValueError("Press a fob button before checking its duplicate.")
            counter = self.fob_counter if repeated else self.fob_counter + 1
            lock = self.fob_lock if repeated else action == "fob_lock"
            if counter > 0xFFFFFFFF:
                raise ValueError("The classroom fob counter is exhausted.")
            if counter <= self.receiver_counter:
                next_state = replace(self, decision="duplicate")
            else:
                blocked = lock and (self.left_open or self.right_open)
                next_state = replace(self, fob_counter=counter, receiver_counter=counter,
                                     fob_lock=lock, decision="door_open" if blocked else "accepted")
                if not blocked:
                    next_state = replace(next_state, locked=lock, revision=(self.revision + 1) % 256)
            frames = [(FOB_RECEIPT_ID, next_state.receipt_payload())]
            if next_state.decision == "accepted":
                frames.append((BODY_STATUS_ID, next_state.status_payload(True)))
            return next_state, frames

        if action in ("open_left", "open_right") and self.locked:
            raise ValueError("Unlock the doors before opening one.")
        if action == "lock" and (self.left_open or self.right_open):
            raise ValueError("Close both doors before locking.")
        changes = {
            "lights_off": {"lights": 0}, "low_beam": {"lights": 1}, "high_beam": {"lights": 2},
            "signal_off": {"signal": 0}, "signal_left": {"signal": 1},
            "signal_right": {"signal": 2}, "hazards": {"signal": 3},
            "wiper_off": {"wiper": False}, "wiper_on": {"wiper": True},
            "open_left": {"left_open": True}, "close_left": {"left_open": False},
            "open_right": {"right_open": True}, "close_right": {"right_open": False},
            "lock": {"locked": True}, "unlock": {"locked": False},
        }
        next_state = replace(self, **changes[action], revision=(self.revision + 1) % 256)
        return next_state, [(BODY_STATUS_ID, next_state.status_payload(False))]
