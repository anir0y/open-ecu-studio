# Installation

Use the browser app on macOS or Linux, or build the desktop app on an Apple Silicon Mac. Both run a software-only CAN network. The standard browser and desktop setups use the in-memory bus.

Clone this repository using GitHub’s **Code** button and open a terminal in the directory containing `pyproject.toml`. Run the commands below from that directory.

## Browser app

Install Python 3.11 or later, Node.js 22.12 or later in the 22.x line, and pnpm 12. The development Mac used Python 3.14.8, Node.js 22.22.2 and pnpm 12.15.0.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[ui,test]'
pnpm --dir ui install --frozen-lockfile
pnpm --dir ui build
.venv/bin/ecu-can-ui --interface virtual --channel studio --host 127.0.0.1 --port 8765
```

Open the local console. When **Lab connected** appears, select **Dynamics model** and **Start simulation**. The bus rate should rise above zero. Press **Ctrl+C** in the terminal to stop the server. [Open the local console](http://127.0.0.1:8765)

To start it another day, run the last command again. If the browser reports that the UI is missing, run the frontend build command and restart the server. If the port is busy, choose another port with `--port` and use that port in the browser.

### Cloudflare Worker deployment

The hosted classroom is available at [ecu-studio.anir0y.in](https://ecu-studio.anir0y.in). It runs the synthetic dynamics lab in an isolated Durable Object session for each browser profile.

With Wrangler authenticated to the intended Cloudflare account, build and deploy from the repository root:

```sh
pnpm --dir ui install --frozen-lockfile
pnpm --dir ui test:worker
pnpm --dir ui worker:deploy
```

The custom hostname is declared in `ui/wrangler.jsonc`. No D1 database or deployment secret is required. The hosted version deliberately disables STM32 firmware rehosting; use the local browser or desktop setup for Unicorn or Renode experiments.

### STM32 reference image

The **STM32 reference ECU** option loads `firmware/reference_ecu/build/reference_ecu.elf`. If the image is missing, or you have edited its C source, install GNU Make and the GNU Arm embedded toolchain (including `arm-none-eabi-gcc`). Compile the image with the project Makefile.

```sh
make -C firmware/reference_ecu
```

The browser and desktop apps run this image in Unicorn when using the in-memory bus. Run the firmware build before packaging a desktop app or Docker image from a checkout without the ELF.

## Apple Silicon desktop app

After installing the tools above and running `pnpm --dir ui install --frozen-lockfile`, build the signed-as-available Apple Silicon disk image and open the packaged app.

```sh
pnpm --dir ui desktop:package
open "outputs/desktop/mac-arm64/Open ECU Studio.app"
```

The distributable disk image is written to `outputs/desktop/Open-ECU-Studio-<version>-arm64.dmg`. The package includes the frontend, Python backend, reference firmware and the Open ECU Studio application icon. Launching the app starts its own local server. It opens on the second display when one is connected and uses the primary display otherwise. Choose **Detach controls** for the two-window layout.

The local build is ad-hoc signed when no Apple Developer identity is configured. Gatekeeper may require a control-click and **Open** on another Mac. A public release should be Developer ID signed and notarized.

## Docker command-line demo

The Dockerfile builds the Python demo and tests. Start Docker, then build the image from the repository directory.

```sh
docker build -t open-ecu-studio:local .
docker run --rm open-ecu-studio:local
docker run --rm open-ecu-studio:local pytest
```

The default command prints the results of a short virtual-bus run. The container uses the in-memory bus and needs no device passthrough.

## Optional Linux virtual CAN interface

Use this route in a Linux VM when you want to observe the lab from a second process with SocketCAN tools. Complete the browser setup inside the VM. Use a kernel with the `vcan` module and install `iproute2`, `kmod` and `can-utils`. In a fresh VM, create the virtual interface and start the console.

```sh
./scripts/setup_vcan.sh vcan0
.venv/bin/ecu-can-ui --interface socketcan --channel vcan0 --host 127.0.0.1 --port 8765
```

Open the console in the VM and start **Dynamics model**. In a second VM terminal, `candump vcan0` displays the frames. For **STM32 reference ECU** over SocketCAN, also install Renode and build the reference image. The backend looks for `/opt/renode/renode`. Set `RENODE_PATH` to the executable before starting the server if you installed it elsewhere.
