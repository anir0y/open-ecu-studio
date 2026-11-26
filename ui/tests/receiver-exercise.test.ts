import assert from "node:assert/strict";
import test from "node:test";
import {applyExerciseAction as act, createExercise} from "../src/receiver-exercise.ts";

test("a new exercise starts locked and can only save or try an existing classroom packet", () => {
  const ready = createExercise();
  assert.equal(ready.lastPress, null);
  assert.equal(ready.savedPress, null);
  for (const car of [ready.vulnerable, ready.protected]) {
    assert.equal(car.locked, true);
    assert.equal(car.open, false);
    assert.equal(car.receipt, null);
    assert.equal(car.receiptInput, null);
  }
  assert.deepEqual(act(ready, "save"), ready);
  assert.deepEqual(act(ready, "old_unlock"), ready);
  const pressed = act(ready, "press");
  assert.deepEqual(pressed.lastPress, {counter: 1, data: "5500000001"});
  assert.equal(pressed.savedPress, null);
  for (const car of [pressed.vulnerable, pressed.protected]) {
    assert.equal(car.locked, false);
    assert.deepEqual(car.receiptInput, pressed.lastPress);
    assert.equal(car.receipt?.slice(0, 14), "01000000000100");
  }
  assert.deepEqual(createExercise(), ready);
});

test("saving a press freezes its bytes even after later presses, cabin controls, and repeated tries", () => {
  const first = act(createExercise(), "press");
  const saved = act(first, "save");
  assert.deepEqual(act(saved, "save"), saved);
  assert.equal(saved.vulnerable.bodySent, false);
  assert.equal(saved.protected.bodySent, false);
  assert.equal(saved.protected.body, first.protected.body);
  assert.equal(saved.protected.receipt, first.protected.receipt);
  const newer = act(saved, "press");
  assert.deepEqual(newer.savedPress, first.lastPress);
  assert.deepEqual(newer.lastPress, {counter: 2, data: "5500000002"});
  assert.deepEqual(newer.protected.receiptInput, newer.lastPress);
  const locked = act(newer, "lock");
  const tried = act(locked, "old_unlock");
  assert.equal(tried.vulnerable.receipt?.slice(0, 14), "01000000000100");
  assert.equal(tried.protected.receipt?.slice(0, 14), "02000000000101");
  assert.deepEqual(tried.vulnerable.receiptInput, first.lastPress);
  assert.deepEqual(tried.protected.receiptInput, first.lastPress);
  assert.equal(tried.protected.body, locked.protected.body);
  assert.equal(tried.protected.bodySent, false);
  const pulled = act(tried, "handles");
  assert.deepEqual([pulled.vulnerable.open, pulled.protected.open], [true, false]);
  assert.equal(pulled.vulnerable.receipt, tried.vulnerable.receipt);
  const retried = act(pulled, "old_unlock");
  assert.deepEqual(retried.lastPress, newer.lastPress);
  assert.deepEqual(retried.savedPress, saved.savedPress);
  const replaced = act(retried, "save");
  assert.deepEqual(replaced.savedPress, newer.lastPress);
  assert.deepEqual(replaced.protected.receiptInput, first.lastPress);
  const updated = act(replaced, "old_unlock");
  assert.equal(updated.protected.receipt?.slice(0, 14), "02000000000201");
  assert.deepEqual(updated.vulnerable.receiptInput, newer.lastPress);
  assert.deepEqual(updated.protected.receiptInput, newer.lastPress);
});

test("cabin actions respect door interlocks after a fresh press or duplicate decision", () => {
  const fresh = act(act(createExercise(), "press"), "save");
  const tried = act(fresh, "old_unlock");
  assert.equal(tried.protected.locked, false);
  assert.equal(tried.protected.receipt?.slice(0, 14), "02000000000100");
  const opened = act(tried, "handles");
  const blocked = act(opened, "lock");
  assert.ok(blocked.vulnerable.open && blocked.protected.open);
  assert.ok(!blocked.vulnerable.locked && !blocked.protected.locked);
  assert.ok(!blocked.vulnerable.bodySent && !blocked.protected.bodySent);
  const locked = act(act(blocked, "close"), "lock");
  const held = act(locked, "handles");
  assert.ok(held.vulnerable.locked && held.protected.locked);
  assert.ok(!held.vulnerable.open && !held.protected.open);
});

test("saved input and both decision reports preserve all four counter bytes", () => {
  let session = createExercise();
  for (let presses = 0; presses < 256; presses++) session = act(session, "press");
  session = act(session, "save");
  assert.deepEqual(session.savedPress, {counter: 256, data: "5500000100"});
  session = act(act(session, "lock"), "old_unlock");
  for (const car of [session.vulnerable, session.protected]) {
    assert.equal(car.receipt?.slice(4, 12), "00000100");
    assert.deepEqual(car.receiptInput, session.savedPress);
  }
});
