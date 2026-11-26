#!/usr/bin/env sh
set -eu

interface_name="${1:-vcan0}"

if ! ip link show dev "$interface_name" >/dev/null 2>&1; then
  sudo modprobe can
  sudo modprobe can_raw
  sudo modprobe vcan
  sudo ip link add dev "$interface_name" type vcan
fi

if ! ip -o link show type vcan | awk -v name="$interface_name:" '$2 == name { found=1 } END { exit !found }'; then
  echo "Expected a Linux vcan link named $interface_name" >&2
  exit 1
fi

sudo ip link set dev "$interface_name" down
sudo ip link set dev "$interface_name" mtu 72
sudo ip link set dev "$interface_name" up
ip -details link show "$interface_name"

