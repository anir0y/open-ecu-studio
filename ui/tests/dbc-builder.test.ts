import assert from "node:assert/strict";
import test from "node:test";

import { appendDbcMessage, buildDbcMessage, newMessageDraft, newSignalDraft } from "../src/dbc-builder.ts";
import { parseDbc } from "../src/dbc.ts";

test("visual draft generates a DBC message that the shared parser accepts", () => {
  const draft = newMessageDraft();
  draft.id = "0x541";
  draft.name = "StudentDynamics";
  draft.length = "4";
  draft.signals = [
    { ...newSignalDraft(1), name: "VehicleSpeed", startByte: "0", widthBytes: "2", byteOrder: "little_endian" },
    { ...newSignalDraft(2), name: "Coolant", startByte: "2", widthBytes: "1", byteOrder: "big_endian", signed: true, factor: "1", min: "-40", max: "120", unit: "deg C" },
  ];
  const built = buildDbcMessage(draft);
  assert.deepEqual(built.errors, []);
  assert.match(built.source, /BO_ 1345 StudentDynamics: 4 Lab/);
  assert.match(built.source, /VehicleSpeed : 0\|16@1\+/);
  assert.match(built.source, /Coolant : 23\|8@0-/);
  const parsed = parseDbc(appendDbcMessage("", built.source), "visual.dbc");
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.catalog?.messages[0].signals.map(signal => signal.name), ["VehicleSpeed", "Coolant"]);
});

test("visual draft reports collisions, reserved IDs, and invalid physical ranges", () => {
  const draft = newMessageDraft();
  draft.id = "0x182";
  draft.length = "2";
  draft.signals = [
    { ...newSignalDraft(1), name: "Value", startByte: "0", widthBytes: "2" },
    { ...newSignalDraft(2), name: "Value", startByte: "1", widthBytes: "2", signed: true, factor: "1", min: "-40000", max: "40000" },
  ];
  const errors = buildDbcMessage(draft).errors.join("\n");
  assert.match(errors, /reserved/);
  assert.match(errors, /signal names must be unique/);
  assert.match(errors, /already assigned/);
  assert.match(errors, /exceed the 2-byte payload/);
  assert.match(errors, /representable 16-bit range/);
});

test("visual draft refuses an ID already present in the imported catalog", () => {
  const draft = newMessageDraft();
  draft.id = "1344";
  assert.match(buildDbcMessage(draft, [0x540]).errors.join("\n"), /already exists/);
});
