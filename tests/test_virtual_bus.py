import json
import subprocess
from unittest.mock import Mock

import pytest

from ecu_lab import bus
from ecu_lab.demo import run_demo
from ecu_lab.server import LabRuntime


@pytest.mark.parametrize("entry", [run_demo, LabRuntime])
@pytest.mark.parametrize("info", [{"info_kind": "can"}, {}, None])
def test_invalid_link_is_rejected_before_opening_a_socket(monkeypatch, entry, info):
    links = [{"ifname": "vcan0", "linkinfo": info}]
    probe = Mock(return_value=subprocess.CompletedProcess([], 0, stdout=json.dumps(links)))
    monkeypatch.setattr(bus.subprocess, "run", probe)
    constructor = Mock()
    monkeypatch.setattr(bus.can, "Bus", constructor)
    with pytest.raises(ValueError, match="requires a Linux vcan"):
        entry("socketcan", "vcan0")
    constructor.assert_not_called()


def test_verified_vcan_can_have_a_custom_name(monkeypatch):
    result = subprocess.CompletedProcess([], 0, stdout='[{"ifname":"lesson1","linkinfo":{"info_kind":"vcan"}}]')
    probe = Mock(return_value=result)
    constructor = Mock()
    monkeypatch.setattr(bus.subprocess, "run", probe)
    monkeypatch.setattr(bus.can, "Bus", constructor)
    assert bus.open_lab_bus("socketcan", "lesson1") is constructor.return_value
    assert probe.call_args.args[0] == ["ip", "-j", "-d", "link", "show", "dev", "lesson1"]
    constructor.assert_called_once_with(interface="socketcan", channel="lesson1", receive_own_messages=False, fd=True)
