#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_venv="$project_root/work/desktop-build-venv"

python3 -m venv "$build_venv"
"$build_venv/bin/pip" install -q -e "$project_root[ui,desktop]"
"$build_venv/bin/pyinstaller" \
  --noconfirm \
  --clean \
  --onefile \
  --name open-ecu-backend \
  --distpath "$project_root/dist" \
  --workpath "$project_root/work/pyinstaller" \
  --specpath "$project_root/work" \
  --paths "$project_root" \
  --hidden-import can.interfaces.virtual \
  --collect-binaries unicorn \
  --collect-submodules unicorn.unicorn_py3.arch \
  --add-data "$project_root/ecu_lab/ui_dist:ecu_lab/ui_dist" \
  --add-data "$project_root/firmware:firmware" \
  "$project_root/desktop_backend.py"
