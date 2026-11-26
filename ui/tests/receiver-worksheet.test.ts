import assert from "node:assert/strict";
import test from "node:test";
import {receiverWorksheetCsv} from "../src/packets.ts";
import {applyExerciseAction, createExercise, type ExerciseAction} from "../src/receiver-exercise.ts";

function worksheet(...actions: ExerciseAction[]) {
  const run = actions.reduce(applyExerciseAction, createExercise());
  const csv = receiverWorksheetCsv(run);
  const [headers, ...rows] = csv.trimEnd().split("\r\n").map(line =>
    Array.from(line.matchAll(/(?:^|,)"((?:[^"]|"")*)"(?=,|$)/g), match => match[1].replaceAll('""', '"'))
  );
  return rows.map(row => {
    assert.equal(row.length, headers.length);
    return Object.fromEntries(headers.map((header, column) => [header, row[column]]));
  });
}

const saved = "Saved unlock packet (hex)";
const input = "Fob input used (hex)";
const vulnerableReply = "Vulnerable response 0x362 (hex)";
const protectedReply = "Protected response 0x362 (hex)";
const vulnerableHandle = "Vulnerable handle result";
const protectedHandle = "Protected handle result";
const vulnerableBody = "Vulnerable new body frame 0x361 (hex)";
const protectedBody = "Protected new body frame 0x361 (hex)";
const first = "55 00 00 00 01";
const second = "55 00 00 00 02";

test("a student's saved input, paired responses and handle result survive later actions", () => {
  const rows = worksheet("press", "save", "press", "lock", "old_unlock", "handles", "close", "save", "old_unlock");
  assert.deepEqual(rows.map(row => row.Step), ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  const [fresh, kept, later, lock, tried, pulled, closed, replaced, retried] = rows;
  const columns = Object.keys(tried);
  assert.equal(columns.indexOf(protectedReply), columns.indexOf(vulnerableReply) + 1);
  assert.deepEqual([fresh[saved], fresh[input], kept[saved], kept[input]], ["", first, first, ""]);
  assert.deepEqual([later[saved], later[input]], [first, second]);
  assert.equal(tried.Action, "Try saved packet");
  assert.deepEqual([tried[saved], tried[input], tried[vulnerableReply], tried[protectedReply]],
    [first, first, "01 00 00 00 00 01 00 04", "02 00 00 00 00 01 01 03"]);
  assert.deepEqual([tried["Vulnerable decision"], tried["Protected decision"]], ["Accepted", "Duplicate rejected"]);
  assert.equal(pulled.Action, "Pull both handles");
  assert.deepEqual([pulled[vulnerableHandle], pulled[protectedHandle]], ["Opened", "Stayed closed (locked)"]);
  assert.deepEqual([pulled[vulnerableBody], pulled[protectedBody]], ["00 00 01 00 00 01 00 05", ""]);
  for (const row of [kept, lock, pulled, closed, replaced]) {
    assert.deepEqual([row[input], row[vulnerableReply], row[protectedReply]], ["", "", ""]);
  }
  assert.equal(replaced[saved], second);
  assert.deepEqual([retried[saved], retried[input]], [second, second]);
  assert.equal(retried[protectedReply], "02 00 00 00 00 02 01 03");
});

test("each handle pull records the actual transition, even out of the suggested order", () => {
  const [locked, fresh, savedPress, tried, opened, repeated, closed] =
    worksheet("handles", "press", "save", "old_unlock", "handles", "handles", "close");
  assert.deepEqual([locked[vulnerableHandle], locked[protectedHandle]], ["Stayed closed (locked)", "Stayed closed (locked)"]);
  assert.equal(tried["Protected decision"], "Duplicate rejected");
  assert.equal(tried["Protected lock after action"], "Unlocked");
  assert.deepEqual([opened[vulnerableHandle], opened[protectedHandle]], ["Opened", "Opened"]);
  assert.deepEqual([repeated[vulnerableHandle], repeated[protectedHandle]], ["Already open", "Already open"]);
  for (const row of [fresh, savedPress, tried, closed]) {
    assert.deepEqual([row[vulnerableHandle], row[protectedHandle]], ["", ""]);
  }
});

test("partial runs contain only observed steps and a reset starts a blank worksheet", () => {
  const rows = worksheet("old_unlock", "save", "press", "save", "save");
  assert.equal(rows.length, 2);
  const [fresh, kept] = rows;
  assert.equal(fresh.Step, "1");
  assert.equal(kept.Step, "2");
  assert.equal(kept[saved], first);
  assert.deepEqual([kept[vulnerableHandle], kept[protectedHandle], kept[vulnerableBody], kept[protectedBody]], ["", "", "", ""]);
  assert.deepEqual(worksheet(), []);
  assert.deepEqual(worksheet("press"), [fresh]);
});
