import assert from "node:assert/strict";
import test from "node:test";

import {LabSimulation} from "./lab.ts";

test("cloud simulation emits classical CAN, CAN FD and freezes a split-grip event", () => {
  const lab = new LabSimulation();
  lab.controlCapture("arm");
  lab.start("synthetic");
  let now = Date.now();
  for (let index = 0; index < 4; index++) lab.tick(now += 100);
  lab.setFault(true);
  for (let index = 0; index < 30 && lab.status().esc_capture.state !== "frozen"; index++) lab.tick(now += 100);
  const status = lab.status();
  assert.equal(status.interface, "cloudflare");
  assert.equal(status.esc_capture.complete, true);
  assert.equal(status.esc_capture.event?.source, "synthetic");
  const frames = lab.traceFrames();
  assert(frames.some(frame => frame.id === "0x181" && !frame.is_fd));
  assert(frames.some(frame => frame.id === "0x510" && frame.is_fd && frame.dlc === 16));
});

test("cloud body controls and diagnostics preserve the teaching packet shapes", () => {
  const lab = new LabSimulation();
  let status = lab.bodyAction("signal_left");
  assert.equal(status.body.signal, 1);
  assert.equal(status.body_frames["0x361"].data.slice(2, 4), "01");
  status = lab.bodyAction("fob_unlock");
  assert.equal(status.body.decision, "accepted");
  assert.equal(status.body_frames["0x362"].dlc, 8);
  const diagnostic = lab.diagnostic("software_version");
  assert.deepEqual(diagnostic, {request: "22F1A0", response: "62F1A00100", positive: true});
});

test("cloud deployment rejects the unavailable firmware runtime", () => {
  const lab = new LabSimulation();
  assert.throws(() => lab.start("firmware"), /desktop and local apps/);
  assert.equal(lab.status().capabilities.firmware, false);
});
