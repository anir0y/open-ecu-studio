// Invoked by test_desktop.mjs <packaged macOS app> --controls.
import assert from "node:assert/strict";
import path from "node:path";

export async function verifyDetachedControls(app, page, {
  backendChildren, btn, download, errors, frozenEvent, runDir, status, until, worksheetRows,
}) {
  const originalBackend = backendChildren(app.process().pid);
  const channel = (await status(page)).channel;
  const detach = btn(page, "Detach controls");
  const nativeMain = await app.browserWindow(page);
  const windowCount = () => app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().length);
  async function openControls() {
    const [child] = await Promise.all([app.waitForEvent("window"), detach.click()]);
    child.setDefaultTimeout(15000);
    child.on("pageerror", error => errors.push(error.message));
    await btn(child, "Dock controls").waitFor();
    assert.equal(await windowCount(), 2);
    assert.equal(await child.locator("canvas").count(), 0, "Only the presentation should render the cars");
    return child;
  }
  const controls = await openControls();
  const nativeControls = await app.browserWindow(controls);
  const childId = await nativeControls.evaluate(win => win.id);
  const placement = await app.evaluate(({screen, BrowserWindow}, id) => {
    const child = BrowserWindow.fromId(id);
    const main = BrowserWindow.getAllWindows().find(win => win !== child);
    const primary = screen.getPrimaryDisplay();
    const second = screen.getAllDisplays().find(display => display.id !== primary.id);
    const bounds = child.getBounds();
    return {screen2:second?.id, workArea:second?.workArea, label:second?.label,
      bounds, main:main.getBounds(), visible:child.isVisible(),
      display:screen.getDisplayMatching(bounds).id, mainDisplay:screen.getDisplayMatching(main.getBounds()).id};
  }, childId);
  assert(placement.screen2 && placement.visible && placement.display === placement.screen2 &&
    placement.mainDisplay === placement.screen2, JSON.stringify(placement));
  const {bounds, main, workArea} = placement;
  if (main.width + bounds.width + 8 <= workArea.width) {
    assert(bounds.x >= main.x + main.width || main.x >= bounds.x + bounds.width, "The controls should sit beside the car");
  }
  assert(bounds.width < main.width * 0.6 && bounds.x >= workArea.x && bounds.y >= workArea.y &&
    bounds.x + bounds.width <= workArea.x + workArea.width &&
    bounds.y + bounds.height <= workArea.y + workArea.height, JSON.stringify(placement));
  await btn(page, "Show controls").click();
  await until(() => nativeControls.evaluate(win => win.isFocused()), "the same controls window to regain focus");
  assert.equal(await windowCount(), 2);
  console.log("PASS compact controls and main presentation on Screen 2, refocus reused the window", JSON.stringify(placement));

  const tab = name => controls.getByRole("tab", {name, exact:true}).click();
  await btn(controls, "Start simulation").click();
  assert.equal(await btn(page, "Stop simulation").count(), 0, "Drive commands should move to the controls window");
  await btn(controls, "Slalom").click();
  await until(async () => (await status(page)).decoded.steering_angle_deg > 10 &&
    Number(await page.locator(".speed-readout strong").innerText()) > 0, "motion in the main car view");
  await btn(controls, "Center steering").click();
  await until(async () => Math.abs((await status(page)).decoded.steering_angle_deg) < 0.05 &&
    (await controls.locator(".steer-feedback strong").innerText()) === "0.0°", "centered steering");
  await btn(controls, "Cruise").click();
  await page.screenshot({path:path.join(runDir, "car-on-screen-2.png")});
  await controls.screenshot({path:path.join(runDir, "detached-drive.png")});
  console.log("PASS detached start, steering, centering and live speed on the main screen");

  await tab("Body");
  const group = name => controls.getByRole("group", {name, exact:true});
  await btn(group("Headlights"), "High beam").click();
  await btn(group("Indicators"), "Right").click();
  await btn(group("Left door"), "Open").click();
  await until(async () => {
    const {body, body_frames} = await status(page);
    return body.lights === 2 && body.signal === 2 && body.left_open && body_frames["0x361"].data.startsWith("020201");
  }, "body switches and emitted body status frame");
  await btn(group("Left door"), "Closed").click();
  console.log("PASS detached headlights, indicators, left door and shared body telemetry");

  await tab("Receiver");
  const twins = page.getByRole("region", {name:"Live receiver comparison"});
  await twins.locator(".twin-car-stage canvas").waitFor();
  await btn(controls, "Press fob unlock").click();
  await btn(controls, "Pull both handles").click();
  const doorLabels = twins.locator(".comparison-state");
  await until(async () => (await doorLabels.allInnerTexts()).filter(t => t === "Unlocked\nLeft door open").length === 2,
    "both normal unlocks reflected in the main comparison");
  await btn(controls, "Close both doors").click();
  await btn(controls, "Lock both cars").click();
  await until(async () => (await doorLabels.allInnerTexts()).filter(t => t === "Locked\nLeft door closed").length === 2,
    "both closed and locked doors on the main screen");
  console.log("PASS ordinary fob, handles and locks operate the two displayed cars");

  await tab("Analysis");
  await controls.getByRole("combobox", {name:"Worked example"}).selectOption({label:"Rear-left wheel slip"});
  await page.locator("#packet-lesson .lesson-origin").filter({hasText:"Rear-left wheel slip"}).waitFor();
  await controls.getByRole("combobox", {name:"Highlight signal"}).selectOption({label:"Rear left"});
  await page.locator("#packet-lesson caption").filter({hasText:"Rear left"}).waitFor();
  await btn(controls, "Arm for first slip").click();
  await tab("Drive");
  await until(async () => (await status(page)).decoded.wheel_speeds_kph[0] > 20, "split-grip exercise speed", 20000);
  await btn(controls, "Split grip").click();
  const event = await frozenEvent(page);
  await tab("Analysis");
  await page.locator('#esc-event[data-state="frozen"]').waitFor();
  const worksheet = await download(app, btn(controls, "Download event worksheet (CSV)"), "detached-esc.csv");
  const rows = worksheetRows(worksheet);
  assert(rows.some(row => row.Phase === "First slip"));
  assert(rows.every(row => row["Slip frame"] === String(event.wheels.sequence)));
  await controls.screenshot({path:path.join(runDir, "detached-analysis.png")});
  assert.equal((await status(page)).channel, channel);
  assert.deepEqual(backendChildren(app.process().pid), originalBackend);
  console.log("PASS packet selection, freeze and native worksheet download from one simulation, slip frame", event.wheels.sequence);

  await btn(controls, "Dock controls").click();
  await detach.waitFor();
  await until(async () => controls.isClosed() && await windowCount() === 1, "button dock");
  await until(() => detach.evaluate(button => document.activeElement === button), "keyboard focus back on Detach controls");
  assert(await btn(page, "Stop simulation").isVisible());
  assert.equal((await status(page)).esc_capture.event.wheels.sequence, event.wheels.sequence);
  const reopened = await openControls();
  const nativeReopened = await app.browserWindow(reopened);
  await nativeReopened.evaluate(win => win.close());
  await detach.waitFor();
  await until(async () => reopened.isClosed() && await windowCount() === 1, "native close restores controls");
  await until(() => detach.evaluate(button => document.activeElement === button), "keyboard focus after native close");
  assert.equal((await status(page)).channel, channel);
  await btn(page, "Stop simulation").click();
  await btn(page, "Start simulation").waitFor();
  const last = await openControls();
  await nativeMain.evaluate(win => win.close());
  await until(async () => last.isClosed() && await windowCount() === 0, "closing the presentation removes the controls");
  console.log("PASS dock during live capture, reopen, native close, restore, and close both windows with the presentation");
}
