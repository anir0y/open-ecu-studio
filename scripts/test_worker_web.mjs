import assert from "node:assert/strict";
import {createRequire} from "node:module";

const require = createRequire(import.meta.url);
const moduleName = process.env.ECU_PLAYWRIGHT_MODULE ||
  (["playwright", "playwright-core"].find(name => {
    try { require.resolve(name); return true; } catch { return false; }
  }));
assert(moduleName, "Install Playwright or set ECU_PLAYWRIGHT_MODULE to the installed package.");
const {chromium} = require(moduleName);
const baseUrl = new URL(process.argv[2] || "http://127.0.0.1:8788").origin;
const executablePath = process.env.ECU_CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({executablePath, headless: true});
const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
const errors = [];
page.on("pageerror", error => errors.push(error.message));

async function status() {
  return page.evaluate(async () => {
    const session = localStorage.getItem("open-ecu-cloud-session-v1") ?? "";
    return (await fetch("/api/status", {headers: {"X-ECU-Session": session}})).json();
  });
}

async function until(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

try {
  await page.goto(baseUrl, {waitUntil: "domcontentloaded"});
  await page.getByText("Lab connected", {exact: true}).waitFor();
  const initial = await status();
  assert.equal(initial.interface, "cloudflare");
  assert.equal(initial.capabilities.firmware, false);
  assert(await page.getByRole("button", {name: /STM32 reference ECU/}).isDisabled());
  assert(await page.getByText("Desktop and local app only", {exact: true}).isVisible());

  await page.getByRole("button", {name: "Start simulation", exact: true}).click();
  await until(async () => (await status()).frame_count >= 20, "cloud CAN frames");
  const indicators = page.getByRole("group", {name: "Indicators"});
  await indicators.getByRole("button", {name: "Left", exact: true}).click();
  await until(async () => (await status()).body.signal === 1, "left indicator body frame");

  const capture = page.getByRole("region", {name: "Freeze ESC event"});
  await capture.getByRole("button", {name: "Arm for first slip", exact: true}).click();
  await page.getByRole("button", {name: "Split grip", exact: true}).click();
  await until(async () => (await status()).esc_capture.complete, "frozen ESC event");
  await capture.getByRole("button", {name: "Download event worksheet (CSV)", exact: true}).waitFor();

  await page.getByRole("button", {name: /^Software version/}).click();
  await until(async () => (await page.locator(".diagnostic-deck output").innerText()).replaceAll(" ", "").includes("RX62F1A00100"), "UDS software response");
  await page.getByRole("button", {name: "Stop simulation", exact: true}).click();
  await until(async () => !(await status()).running, "simulation stop");
  assert.deepEqual(errors, []);
  console.log("PASS Worker web app", baseUrl, "frames", (await status()).frame_count);
} finally {
  await browser.close();
}
