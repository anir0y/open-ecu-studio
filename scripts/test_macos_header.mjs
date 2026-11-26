// macOS only. ECU_PLAYWRIGHT_MODULE can point to an installed Playwright package.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(process.platform, "darwin", "This check needs the native macOS window buttons.");
assert(process.argv[2], "Pass the path to the packaged app and optionally an evidence directory.");
const require = createRequire(import.meta.url);
const { _electron } = require(process.env.ECU_PLAYWRIGHT_MODULE || "playwright");
const evidence = path.resolve(process.argv[3] || "work/macos-header");
mkdirSync(evidence, {recursive: true});
const profile = mkdtempSync(path.join(tmpdir(), "ecu-macos-header-"));
const env = {...process.env};
delete env.ECU_CAN_BACKEND_URL;
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({
  executablePath: path.resolve(process.argv[2], "Contents/MacOS/Open ECU Studio"),
  args: ["--user-data-dir=" + profile], env,
});
try {
  const page = await app.firstWindow();
  const win = await app.browserWindow(page);
  await page.getByText("Lab connected", {exact: true}).waitFor();
  await page.evaluate(() => document.fonts.ready.then(() => true));
  const expectedDisplay = await app.evaluate(({screen}) => {
    const primary = screen.getPrimaryDisplay();
    return (screen.getAllDisplays().find(display => display.id !== primary.id) || primary).id;
  });
  const failures = [];
  async function checkHeader(label) {
    await app.evaluate(({app}) => app.focus({steal: true}));
    await win.evaluate(w => w.focus());
    const native = await win.evaluate(w => ({
      id: w.getMediaSourceId().split(":")[1], bounds: w.getBounds(), content: w.getContentBounds(),
    }));
    const display = await app.evaluate(({screen}, bounds) => {
      const {id, label} = screen.getDisplayMatching(bounds);
      return {id, label};
    }, native.bounds);
    assert.equal(display.id, expectedDisplay);
    // Bounding boxes include the skew on the mark. Adjust them into window coordinates.
    const rect = async selector => {
      const box = await page.locator(selector).boundingBox();
      assert(box, selector);
      return {...box, x: box.x + native.content.x - native.bounds.x, y: box.y + native.content.y - native.bounds.y};
    };
    const logo = await rect(".studio-glyph");
    const title = await rect(".studio-identity strong");
    const imagePath = path.join(profile, "native-window.png");
    const output = path.join(evidence, label + ".png");
    let measured;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      execFileSync("/usr/sbin/screencapture", ["-x", "-o", "-l", native.id, imagePath]);
      measured = await app.evaluate(({nativeImage}, {imagePath, width, title}) => {
        const full = nativeImage.createFromPath(imagePath).resize({width});
        const crop = full.crop({x: 0, y: 0, width: Math.min(width, 400), height: 88});
        const size = crop.getSize();
        const bytes = crop.toBitmap();
        let greenRight = -1, greenBottom = -1, letters = 0;
        for (let y = 0; y < size.height; y++) {
          for (let x = 0; x < size.width; x++) {
            const i = (y * size.width + x) * 4;
            const [b, g, r] = [bytes[i], bytes[i + 1], bytes[i + 2]];
            if (x < 105 && y < 65 && g > 115 && g > r * 1.22 && g > b * 1.55) {
              greenRight = Math.max(greenRight, x + 1);
              greenBottom = Math.max(greenBottom, y + 1);
            }
            if (x >= title.x && x < title.x + title.width && y >= title.y && y < title.y + title.height &&
                Math.min(r, g, b) > 130) letters++;
          }
        }
        if (greenRight < 0 || letters < 20) return null;
        return {greenRight, greenBottom, png: crop.toPNG().toString("base64")};
      }, {imagePath, width: native.bounds.width, title});
      if (measured) break;
      await delay(100);
    }
    if (!measured) {
      copyFileSync(imagePath, path.join(evidence, label + "-failed.png"));
      throw Error("Could not capture both the green window button and rendered title: " + JSON.stringify({native, logo, title}));
    }
    writeFileSync(output, Buffer.from(measured.png, "base64"));
    const gap = Math.max(logo.x - measured.greenRight, logo.y - measured.greenBottom);
    console.log(label, display.label, native.bounds.width + "px", "window button right", measured.greenRight,
      "logo starts", logo.x.toFixed(1), "clearance", gap.toFixed(1), "px");
    if (gap < 8) failures.push(label + ": " + gap.toFixed(1) + "px clearance");
  }

  const [normal, minimum] = await win.evaluate(w => [w.getSize()[0], w.getMinimumSize()[0]]);
  await checkHeader("docked-default");
  await page.getByRole("button", {name: "Detach controls", exact: true}).click();
  await page.getByRole("button", {name: "Show controls", exact: true}).waitFor();
  await checkHeader("detached-default");
  for (const width of new Set([Math.round((normal + minimum) / 2), minimum])) {
    await win.evaluate((w, width) => w.setSize(width, w.getSize()[1]), width);
    await page.waitForFunction(width => window.innerWidth === width, width);
    await checkHeader("detached-" + width);
  }
  await page.getByRole("button", {name: "Dock controls", exact: true}).click();
  await page.getByRole("button", {name: "Detach controls", exact: true}).waitFor();
  await checkHeader("docked-minimum");
  assert.deepEqual(failures, [], "The native window controls overlap the brand or leave less than 8px clearance.");
} finally {
  await app.close();
  rmSync(profile, {recursive: true, force: true});
}
