"""Open the classroom bus in memory or on a Linux vcan link."""

import json
import re
import subprocess

import can


def require_vcan(channel: str) -> None:
    if not re.fullmatch(r"[a-zA-Z0-9_.-]{1,15}", channel):
        raise ValueError("Invalid virtual CAN interface name")
    try:
        result = subprocess.run(
            ["ip", "-j", "-d", "link", "show", "dev", channel],
            capture_output=True, text=True, check=True, timeout=5,
        )
        links = json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        raise ValueError(f"Unable to verify Linux vcan interface {channel!r}") from error
    match links:
        case [{"ifname": name, "linkinfo": {"info_kind": "vcan"}}] if name == channel:
            return
    raise ValueError(f"SocketCAN requires a Linux vcan interface, got {channel!r}")


def open_lab_bus(interface: str, channel: str) -> can.BusABC:
    if interface == "socketcan":
        require_vcan(channel)
    elif interface != "virtual":
        raise ValueError("Select an in-memory virtual bus or a Linux vcan interface")
    return can.Bus(interface=interface, channel=channel, receive_own_messages=False, fd=True)
