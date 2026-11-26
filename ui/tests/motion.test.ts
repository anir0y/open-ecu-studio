import assert from "node:assert/strict";
import test from "node:test";

import { activeMotionValue, advanceRoadStripe, forwardWheelSpin } from "../src/motion.ts";

test("forward travel moves the rolling road toward the vehicle rear", () => {
  assert.ok(advanceRoadStripe(0, 50, 1) < 0);
});

test("forward travel rotates the imported wheels around positive local X", () => {
  assert.ok(forwardWheelSpin(50, 1) > 0);
});

test("rolling-road stripes wrap without reversing direction", () => {
  const wrapped = advanceRoadStripe(-6.95, 50, 1);
  assert.ok(wrapped > 0);
  assert.ok(wrapped <= 7);
});

test("stopping the lab freezes retained telemetry motion", () => {
  assert.equal(activeMotionValue(false, 42), 0);
  assert.equal(activeMotionValue(true, 42), 42);
});
