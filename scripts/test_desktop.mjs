// Run with Node against an actual macOS .app. Set ECU_PLAYWRIGHT_MODULE to a
// Playwright package path if playwright or playwright-core is not installed locally.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { verifyDetachedControls } from "./test_detached_controls.mjs";

const require = createRequire(import.meta.url);
const moduleName = process.env.ECU_PLAYWRIGHT_MODULE ||
  (["playwright", "playwright-core"].find(name => {
    try { require.resolve(name); return true; } catch { return false; }
  }));
assert(moduleName, "Install Playwright or set ECU_PLAYWRIGHT_MODULE to the installed package.");
const { _electron: electron } = require(moduleName);
const bundle = path.resolve(process.argv[2] || "outputs/desktop/mac-arm64/Open ECU Studio.app");
const executablePath = path.join(bundle, "Contents/MacOS/Open ECU Studio");
assert(existsSync(executablePath), executablePath);
const controlsOnly = process.argv.includes("--controls");
if (controlsOnly) mkdirSync("work", {recursive:true});
const runDir = realpathSync(mkdtempSync(controlsOnly
  ? path.resolve("work/detached-controls-e2e-")
  : path.join(tmpdir(), "open-ecu-desktop-e2e-")));
const profile = path.join(runDir, "student");
const launchEnv = {...process.env};
delete launchEnv.ECU_CAN_BACKEND_URL;
delete launchEnv.ELECTRON_RUN_AS_NODE;
const errors = [];

async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  throw Error("Timed out waiting for " + label);
}
function backendChildren(pid) {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,comm="], {encoding:"utf8"}).trim().split("\n")
    .map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean);
  const descendants = new Set([pid]);
  for (let count = 0; count < descendants.size; count++) {
    for (const [, child, parent] of rows) if (descendants.has(Number(parent))) descendants.add(Number(child));
  }
  return rows.filter(([, child,, command]) => descendants.has(Number(child)) && path.basename(command) === "open-ecu-backend").map(row => Number(row[1]));
}
function running(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
const hash = data => createHash("sha256").update(data).digest("hex");
const btn = (scope, name) => scope.getByRole("button", {name, exact:true});
const status = page => page.evaluate(async () => (await fetch("/api/status")).json());

async function withDesktop(check) {
  const app = await electron.launch({executablePath, args:["--user-data-dir=" + profile], env:launchEnv, timeout:45000});
  let backend = [];
  try {
    const meta = await app.evaluate(({app}) => ({packaged:app.isPackaged, profile:app.getPath("userData")}));
    assert(meta.packaged && meta.profile === profile, JSON.stringify(meta));
    const [page, placement] = await Promise.all([app.firstWindow({timeout:45000}), app.evaluate(async ({app, BrowserWindow, screen}) => {
      const window = BrowserWindow.getAllWindows()[0] || await new Promise(resolve => {
        app.once("browser-window-created", (_, created) => resolve(created));
      });
      if (!window.isVisible()) await new Promise(resolve => window.once("show", resolve));
      const displays = screen.getAllDisplays();
      const primary = screen.getPrimaryDisplay();
      const intended = displays.find(display => display.id !== primary.id) || primary;
      const bounds = window.getBounds();
      const shown = screen.getDisplayMatching(bounds);
      return {count:displays.length, expected:intended.id, actual:shown.id, label:shown.label, bounds};
    })]);
    assert.equal(placement.actual, placement.expected, JSON.stringify(placement));
    console.log(placement.count > 1 ? "PASS first show on Screen 2" : "INFO single-display fallback", JSON.stringify(placement));
    page.setDefaultTimeout(25000);
    page.on("pageerror", error => errors.push(error.message));
    await page.getByText("Lab connected", {exact:true}).waitFor();
    backend = backendChildren(app.process().pid);
    assert(backend.length, "The app did not spawn the bundled backend.");
    assert.equal((await status(page)).interface, "virtual");
    assert(await page.locator(".link-state").getByText(/Desktop /).isVisible());
    await check(app, page);
    assert.deepEqual(errors, []);
  } finally {
    await app.close();
    await until(() => backend.every(pid => !running(pid)), "the bundled backend to exit", 15000);
  }
}
async function download(app, link, filename) {
  const destination = path.join(runDir, filename);
  // Supply the path to Electron's native download manager instead of opening a Save dialog.
  await app.evaluate(({session}, target) => {
    session.defaultSession.once("will-download", (_, item) => { item.setSavePath(target); });
  }, destination);
  await link.click();
  await until(() => existsSync(destination) && statSync(destination).size, filename);
  return readFileSync(destination);
}
async function diagnostics(page) {
  for (const [label, expected] of [["Extended session", "5003003201F4"], ["Tester present", "7E00"], ["Software version", "62F1A00100"], ["ESC state", "62F1A1"]]) {
    await page.getByRole("button", {name:new RegExp("^" + label)}).click();
    await until(async () => {
      const result = (await page.locator(".diagnostic-deck output").innerText()).replaceAll(" ", "");
      return result.includes("/RX" + expected) && result.endsWith("/positive");
    }, label + " positive response");
  }
}
const freezePanel = page => page.getByRole("region", {name:"Freeze ESC event"});
const spaced = hex => hex.match(/../g).join(" ");

async function frozenEvent(page) {
  return until(async () => {
    const capture = (await status(page)).esc_capture;
    return capture?.state === "frozen" && capture.complete && capture.event;
  }, "first complete ESC event", 25000);
}

function worksheetRows(bytes) {
  // The generated worksheet has one physical line per field, with optional CSV quotes.
  const lines = bytes.toString("utf8").replace(/^\uFEFF/, "").trimEnd().split(/\r?\n/);
  const rows = lines.map(line => Array.from(
    line.matchAll(/(?:^|,)(?:"((?:[^"]|"")*)"|([^,]*))(?=,|$)/g),
    match => match[1] === undefined ? match[2] : match[1].replaceAll('""', '"'),
  ));
  const header = rows.shift();
  return rows.map(row => {
    assert.equal(row.length, header.length);
    return Object.fromEntries(header.map((name, i) => [name, row[i]]));
  });
}

async function inspectSlip(app, page, source) {
  const event = await frozenEvent(page);
  assert.equal(event.source, source);
  const panel = freezePanel(page);
  await until(async () => (await panel.getAttribute("data-state")) === "frozen", "worksheet frozen in the window");
  const bytes = await download(app, btn(panel, "Download event worksheet (CSV)"), source + "-esc-event.csv");
  const rows = worksheetRows(bytes);
  assert(rows.every(row => row.Source === source && row["Slip frame"] === String(event.wheels.sequence)));
  const rowFor = field => {
    const row = rows.find(record => record.Phase === "First slip" && record.Field === field);
    assert(row, "Missing worksheet field: " + field);
    return row;
  };
  const columns = ["Wheel speeds (0x181)", "Brake pressure (0x182)", "ESC status (0x280)"];
  const packets = [event.wheels, event.dynamics, event.esc];
  const cards = ["Wheel speeds", "Brake pressure", "ESC status"].map(name => panel.getByRole("article", {name, exact:true}));
  for (const [i, packet] of packets.entries()) {
    assert.equal(rowFor("Frame sequence")[columns[i]], String(packet.sequence));
    assert.equal(rowFor("Payload (hex)")[columns[i]], spaced(packet.data));
    assert.equal(rowFor("Time (UTC)")[columns[i]], new Date(packet.timestamp * 1000).toISOString());
    assert.equal(rowFor("Offset from first slip (ms)")[columns[i]], ((packet.timestamp-event.wheels.timestamp)*1000).toFixed(3));
    assert((await cards[i].innerText()).includes(spaced(packet.data)), "Actual payload on " + columns[i]);
  }
  const boxes = await Promise.all(cards.map(card => card.boundingBox()));
  assert(boxes.every((box,i) => box && (i === 0 || (Math.abs(box.y - boxes[0].y) < 2 && box.x >= boxes[i-1].x + boxes[i-1].width - 1))), "Three visible side-by-side packets");
  const trace = JSON.parse(await download(app, page.getByRole("link", {name:"Export JSON trace"}), source + "-event-trace.json"));
  for (const packet of [event.baseline, ...packets]) {
    const observed = trace.find(frame => frame.sequence === packet.sequence);
    assert.deepEqual(observed, packet, "Frozen event must match the original trace frame");
  }
  assert(event.baseline.sequence < event.wheels.sequence && event.wheels.sequence < event.dynamics.sequence && event.dynamics.sequence < event.esc.sequence);
  const wheelBytes = Buffer.from(event.wheels.data, "hex");
  const baseBytes = Buffer.from(event.baseline.data, "hex");
  const wheelDelta = data => data.readUInt16BE(0) - data.readUInt16BE(4);
  assert(wheelDelta(baseBytes) < 400 && wheelDelta(wheelBytes) >= 400, "First rear-left slip crossing");
  const wheelFields = ["Front left (km/h)", "Front right (km/h)", "Rear left (km/h)", "Rear right (km/h)"];
  const displayedWheels = await cards[0].locator("dd").allTextContents();
  for (const [i, field] of wheelFields.entries()) {
    assert.equal(Number(rowFor(field)[columns[0]]), wheelBytes.readUInt16BE(2*i) / 100);
    assert.equal(parseFloat(displayedWheels[i]), wheelBytes.readUInt16BE(2*i) / 100);
  }
  const pressure = Buffer.from(event.dynamics.data, "hex").readUInt16BE(4) / 10;
  assert.equal(Number(rowFor("Brake pressure (bar)")[columns[1]]), pressure);
  assert.equal(parseFloat(await cards[1].locator("dd").first().innerText()), pressure);
  assert.equal(Buffer.from(event.esc.data, "hex")[2] & 1, 1);
  assert.equal(rowFor("ESC intervention")[columns[2]], "Active");
  assert.equal((await cards[2].locator("dd").first().innerText()).trim(), "Active");
  const previous = rows.find(record => record.Phase === "Before slip" && record.Field === "Payload (hex)");
  assert.equal(previous?.[columns[0]], spaced(event.baseline.data));
  if (source === "firmware") {
    assert.equal(event.baseline.data, "0FA00FA00FA00FA0");
    assert.equal(event.wheels.data, "0FA00FA00BB80FA0");
    assert.equal(pressure, 60);
    await panel.screenshot({path:path.join(runDir, "esc-event-screen2.png")});
    const nav = page.getByRole("navigation", {name:"Workspace"});
    await nav.getByRole("link", {name:"Author", exact:true}).click();
    await page.getByRole("heading", {name:"Animesh Roy", exact:true}).waitFor();
    assert.equal((await status(page)).source, "firmware");
    await page.getByRole("link", {name:"Return to lab", exact:true}).click();
    await panel.waitFor();
    assert.deepEqual(await download(app, btn(panel, "Download event worksheet (CSV)"), "firmware-returned.csv"), bytes);
  }
  await until(async () => (await status(page)).frame_count > event.esc.sequence + 5, "live traffic after the frozen sample");
  assert.deepEqual((await status(page)).esc_capture.event, event, "Frozen readings must remain stable while the bus runs");
  console.log("PASS frozen", source, "event, sequences", packets.map(packet => packet.sequence), "brake bar", pressure, "CSV SHA-256", hash(bytes));
  return event;
}
async function dynamics(app, page) {
  await btn(page, "Start simulation").click();
  await btn(page, "Slalom").click();
  await until(async () => {
    const data = await status(page);
    return data.source === "synthetic" && data.vehicle.vehicle_speed_kph > 0 && data.decoded.steering_angle_deg > 10;
  }, "throttle, motion and steering telemetry");
  await page.locator(".steer-feedback").getByText(/Measured/).waitFor();
  await btn(page, "Center steering").click();
  await until(async () => (await page.locator(".steer-feedback strong").innerText()) === "0.0°", "centered road wheels");
  await btn(page, "Cruise").click();
  await until(async () => (await status(page)).decoded.wheel_speeds_kph[0] > 20, "enough speed for the split-grip exercise", 20000);
  const eventPanel = freezePanel(page);
  await btn(eventPanel, "Arm for first slip").click();
  await until(async () => (await status(page)).esc_capture?.state === "armed", "armed dynamics capture");
  await btn(page, "Split grip").click();
  await inspectSlip(app, page, "synthetic");
  await btn(eventPanel, "Return to live").click();
  await btn(eventPanel, "Arm for first slip").waitFor();
  const indicator = page.getByRole("group", {name:"Turn signals", exact:true});
  for (const [name, signal] of [["Left",1],["Right",2],["Hazards",3],["Off",0]]) {
    await btn(indicator, name).click();
    await until(async () => (await status(page)).body.signal === signal && (await btn(indicator, name).getAttribute("aria-pressed")) === "true", name);
  }
  await diagnostics(page);
  const trace = JSON.parse(await download(app, page.getByRole("link", {name:"Export JSON trace"}), "dynamics.json"));
  const ids = new Set(trace.map(frame => frame.id));
  for (const id of ["0x181","0x182","0x183","0x280","0x510","0x6A0","0x6A8","0x361"]) assert(ids.has(id), id);
  assert(trace.some(frame => frame.id === "0x510" && frame.is_fd));
  await btn(page, "Stop simulation").click();
  await btn(page, "Start simulation").waitFor();
  assert.equal(await page.locator(".speed-readout strong").innerText(), "0.0");
  const model = await page.evaluate(() => performance.getEntriesByType("resource").find(entry => entry.name.includes("CarConcept.glb"))?.decodedBodySize);
  assert(model > 1000000 && await page.locator(".model-stage canvas").count() === 1, "3D model load");
  console.log("PASS drive, steering, four signal modes, four diagnostics, CAN FD trace, stop, 3D model", trace.length, "frames");
}
async function receiver(app, page) {
  const stage = page.getByRole("region", {name:"Live receiver comparison"});
  const worksheet = btn(stage, "Download run worksheet (CSV)");
  assert(!(await worksheet.isEnabled()), "Fresh test profile must have no existing run.");
  for (const action of ["Press fob unlock", "Save packet", "Press fob unlock", "Lock both cars", "Try saved packet"]) {
    await btn(stage, action).click();
  }
  await stage.locator(".twin-car-view").scrollIntoViewIfNeeded();
  const canvas = stage.locator(".twin-car-stage canvas");
  await canvas.waitFor();
  const beforePull = await until(async () => {
    const image = await canvas.screenshot();
    // The lazy 3D scene initially renders a flat placeholder.
    return image.length > 20000 && image;
  }, "both 3D cars to render");
  writeFileSync(path.join(runDir, "cars-before.png"), beforePull);
  await btn(stage, "Pull both handles").click();
  const changes = await until(async () => {
    const after = await canvas.screenshot();
    writeFileSync(path.join(runDir, "cars-after.png"), after);
    const change = await app.evaluate(({nativeImage}, [first, second]) => {
      const images = [first, second].map(png => nativeImage.createFromDataURL("data:image/png;base64," + png));
      const {width} = images[0].getSize();
      const [a, b] = images.map(image => image.toBitmap());
      if (a.length !== b.length) return null;
      const counts = [0, 0];
      for (let offset = 0; offset < a.length; offset += 4) {
        const delta = Math.max(...[0,1,2].map(ch => Math.abs(a[offset+ch] - b[offset+ch])));
        if (delta > 35) counts[(offset / 4) % width < width / 2 ? 0 : 1]++;
      }
      return counts;
    }, [beforePull.toString("base64"), after.toString("base64")]);
    return change && change[0] > 500 && change[1] < change[0] / 20 && change;
  }, "the vulnerable door to move while the protected door stays still");
  console.log("PASS 3D door render, changed pixels on vulnerable/protected sides", changes);
  const messages = await stage.locator(".comparison-state").allInnerTexts();
  assert.deepEqual(messages, ["Unlocked\nLeft door open", "Locked\nLeft door closed"]);
  assert.equal(await page.getByText(/3D view unavailable/).count(), 0);
  const bytes = await download(app, worksheet, "first-run.csv");
  const csv = bytes.toString("utf8");
  assert.match(csv, /"Try saved packet","55 00 00 00 01","55 00 00 00 01","01 00 00 00 00 01 00 04","02 00 00 00 00 01 01 03","Accepted","Duplicate rejected"/);
  assert.match(csv, /"Opened","Stayed closed \(locked\)"/);
  assert.equal(csv.trimEnd().split("\r\n").length, 7);
  console.log("PASS paired receiver decisions, door states and native six-step worksheet download", hash(bytes));
  return bytes;
}
async function firmware(app, page) {
  await page.getByRole("button", {name:/STM32 reference ECU/}).click();
  const panel = freezePanel(page);
  await btn(panel, "Arm for first slip").click();
  await btn(page, "Start simulation").click();
  await until(async () => {
    const data = await status(page);
    return data.source === "firmware" && data.firmware_running && data.frames_per_second > 0;
  }, "live STM32 telemetry on the desktop virtual bus", 30000);
  const firstSlip = await inspectSlip(app, page, "firmware");
  await btn(panel, "Arm for next slip").click();
  const nextSlip = await until(async () => {
    const capture = (await status(page)).esc_capture;
    return capture?.complete && capture.event.wheels.sequence > firstSlip.esc.sequence && capture.event;
  }, "second independent firmware slip", 25000);
  assert.equal(nextSlip.wheels.data, firstSlip.wheels.data);
  await btn(panel, "Return to live").click();
  await diagnostics(page);
  const trace = JSON.parse(await download(app, page.getByRole("link", {name:"Export JSON trace"}), "firmware.json"));
  const ids = new Set(trace.map(frame => frame.id));
  for (const id of ["0x181","0x182","0x280","0x6A0","0x6A8"]) assert(ids.has(id), id);
  assert(trace.some(frame => frame.id === "0x181" && /^0FA00FA0(0FA0|0BB8)0FA0$/.test(frame.data)));
  assert(trace.some(frame => frame.id === "0x182" && frame.data.startsWith("01F4004B")));
  assert(!trace.some(frame => frame.is_fd), "The reference firmware emits classical CAN.");
  await btn(page, "Stop simulation").click();
  await btn(page, "Start simulation").waitFor();
  assert.equal((await status(page)).firmware_running, false);
  await page.getByRole("button", {name:/Dynamics model/}).click();
  await btn(page, "Start simulation").click();
  await until(async () => (await status(page)).source === "synthetic", "switching back to dynamics");
  await btn(page, "Stop simulation").click();
  await btn(page, "Start simulation").waitFor();
  console.log("PASS STM32 start, reference telemetry bytes, four diagnostics, trace export, stop and switch back", trace.length, "frames");
}

if (controlsOnly) {
  await withDesktop((app, page) => verifyDetachedControls(app, page, {
    backendChildren, btn, download, errors, frozenEvent, runDir, status, until, worksheetRows,
  }));
  // Each engine's trace covers the lifetime of a backend, including earlier runs.
  await withDesktop(dynamics);
  await withDesktop(firmware);
} else {
  let firstRun;
  await withDesktop(async (app, page) => {
    await dynamics(app, page);
    firstRun = await receiver(app, page);
  });
  await withDesktop(async (app, page) => {
    const stage = page.getByRole("region", {name:"Live receiver comparison"});
    assert.deepEqual(await stage.locator(".comparison-state").allInnerTexts(), ["Unlocked\nLeft door open", "Locked\nLeft door closed"]);
    assert.deepEqual(await download(app, btn(stage, "Download run worksheet (CSV)"), "resumed-run.csv"), firstRun);
    await btn(stage, "Close both doors").click();
    await page.reload();
    await btn(stage, "Download run worksheet (CSV)").waitFor();
    assert.deepEqual(await stage.locator(".comparison-state").allInnerTexts(), ["Unlocked\nLeft door closed", "Locked\nLeft door closed"]);
    assert.equal(await stage.getByText("Last handle pull · Step 6 · Opened", {exact:true}).count(), 1);
    await btn(stage, "Reset exercise").click();
    await page.reload();
    await btn(stage, "Download run worksheet (CSV)").waitFor();
    assert(!(await btn(stage, "Download run worksheet (CSV)").isEnabled()));
    console.log("PASS full quit/relaunch, byte-identical CSV, continued run, reload and reset");
    await firmware(app, page);
  });
}
console.log("PASS packaged backend process trees exited; test data in", runDir);
