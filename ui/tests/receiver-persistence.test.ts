import assert from "node:assert/strict";
import test from "node:test";
import {latestHandlePull, receiverWorksheetCsv} from "../src/packets.ts";
import {
  applyExerciseAction, createExercise, restoreExercise, serializeExercise, type ExerciseAction,
} from "../src/receiver-exercise.ts";

test("restoring a partial run preserves the saved press and its identity", () => {
  const empty = createExercise();
  assert.deepEqual(restoreExercise(serializeExercise(empty)), empty);
  const partial = applyExerciseAction(applyExerciseAction(empty, "press"), "save");
  const stored = serializeExercise(partial);
  assert.deepEqual(JSON.parse(stored), {version: 1, actions: ["press", "save"]});
  const restored = restoreExercise(stored);
  assert.deepEqual(restored, partial);
  assert.equal(restored.savedPress, restored.lastPress);
  assert.equal(applyExerciseAction(restored, "save"), restored);
});

test("restored receivers, handle results and worksheet match the uninterrupted run", () => {
  const actions: ExerciseAction[] = ["press", "save", "press", "lock", "old_unlock", "handles"];
  const original = actions.reduce(applyExerciseAction, createExercise());
  const restored = restoreExercise(serializeExercise(original));
  assert.deepEqual(restored, original);
  assert.equal(restored.savedPress?.counter, 1);
  assert.equal(restored.lastPress?.counter, 2);
  assert.equal(restored.vulnerable.receiptInput, restored.savedPress);
  assert.equal(restored.protected.receiptInput, restored.savedPress);
  assert.deepEqual([restored.vulnerable.open, restored.protected.open], [true, false]);
  assert.equal(receiverWorksheetCsv(restored), receiverWorksheetCsv(original));
  const closed = restoreExercise(serializeExercise(applyExerciseAction(restored, "close")));
  assert.deepEqual([closed.vulnerable.open, closed.protected.open], [false, false]);
  assert.deepEqual(latestHandlePull(closed), {step: 6, vulnerable: "Opened", protected: "Stayed closed (locked)"});

  const continuation: ExerciseAction[] = ["close", "lock", "save", "old_unlock", "handles"];
  const continued = continuation.reduce(applyExerciseAction, restored);
  const uninterrupted = continuation.reduce(applyExerciseAction, original);
  assert.deepEqual(continued, uninterrupted);
  assert.equal(receiverWorksheetCsv(continued), receiverWorksheetCsv(uninterrupted));
});

test("invalid or unsupported saved runs fail without returning a partial worksheet", () => {
  const invalid = ["{", "null", "[]", "{}", '{"version":2,"actions":[]}', '{"version":1,"actions":"press"}'];
  for (const actions of [["press", "unknown"], [null], ["save"], ["old_unlock"], ["press", "save", "save"]]) {
    invalid.push(JSON.stringify({version: 1, actions}));
  }
  for (const raw of invalid) assert.throws(() => restoreExercise(raw), raw);
});
