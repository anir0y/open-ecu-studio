import assert from "node:assert/strict";
import test from "node:test";
import { escEventWorksheetCsv, type EscEvent } from "../src/packets.ts";

function observed(id: string, sequence: number, timestamp: number, data: string) {
  return {id, sequence, timestamp, data, is_fd: false, is_extended_id: false};
}

const capture: EscEvent = {
  source: "firmware",
  baseline: observed("0x181", 8, 1001, "0FA00FA00FA00FA0"),
  wheels: observed("0x181", 11, 1002, "0FA00FA00BB80FA0"),
  dynamics: observed("0x182", 12, 1002.005, "01F4004B025801FF"),
  esc: observed("0x280", 18, 1002.105, "0100010200000000"),
};

test("event worksheet pairs real payloads with their own sequence, time, counter and values", () => {
  const csv = escEventWorksheetCsv(capture);
  assert.match(csv, /"Before slip","Rear left \(km\/h\)","40.00","",""/);
  assert.match(csv, /"First slip","Rear left \(km\/h\)","30.00","",""/);
  assert.match(csv, /"First slip","Frame sequence","11","12","18"/);
  assert.match(csv, /"First slip","Offset from first slip \(ms\)","0.000","5.000","105.000"/);
  assert.match(csv, /"First slip","Sample counter","","255","2"/);
  assert.match(csv, /"First slip","Counter offset \(mod 256\)","","0","3"/);
  assert.match(csv, /"First slip","Brake pressure \(bar\)","","60.0",""/);
  assert.match(csv, /"First slip","ESC intervention","","Active","Active"/);
  assert.match(csv, /"First slip","Payload \(hex\)","0F A0 0F A0 0B B8 0F A0","01 F4 00 4B 02 58 01 FF","01 00 01 02 00 00 00 00"/);
  assert.ok(csv.endsWith("\r\n"));
});

test("an interrupted episode leaves missing frames and their decoded fields empty", () => {
  const partial = escEventWorksheetCsv({...capture, esc: null});
  assert.match(partial, /"First slip","Packet observation","Observed","Observed","Missing from this slip episode"/);
  assert.match(partial, /"First slip","Frame sequence","11","12",""/);
  assert.match(partial, /"First slip","ESC intervention","","Active",""/);
  const wheelsOnly = escEventWorksheetCsv({...capture, dynamics: null, esc: null});
  assert.doesNotMatch(wheelsOnly, /"First slip","Brake pressure \(bar\)"/);
});
