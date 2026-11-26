import assert from "node:assert/strict";
import test from "node:test";

import {
  OPEN_ECU_DBC_EXAMPLE,
  dbcWorksheetCsv,
  decodeDbcMessage,
  encodeDbcMessage,
  packetForDbc,
  parseDbc,
  payloadHex,
} from "../src/dbc.ts";

test("parses and round-trips a byte-aligned Motorola signed signal", () => {
  const result = parseDbc(OPEN_ECU_DBC_EXAMPLE, "teaching.dbc");
  assert.deepEqual(result.errors, []);
  const message = result.catalog!.messages[0];
  assert.deepEqual(
    [message.idHex, message.name, message.length, message.signals[0].byteOrder, message.signals[0].signed],
    ["0x520", "BenchTemperature", 2, "big_endian", true],
  );
  const packet = packetForDbc(message, { CoolantTemperature: -2.5 });
  assert.equal(packet.data, "FFE7");
  const field = decodeDbcMessage(message, packet.data).fields[0];
  assert.deepEqual([field.start, field.end, field.result, field.unit], [0, 1, "-2.5", "deg C"]);
  assert.match(dbcWorksheetCsv(message, packet.data), /"CoolantTemperature"[^\n]*"-2.5"/);
});

test("encodes Intel byte order without changing the physical value", () => {
  const source = `BO_ 801 LittleEndian: 2 Lab
 SG_ Counter : 0|16@1+ (1,0) [0|65535] "count" Lab`;
  const message = parseDbc(source).catalog!.messages[0];
  const payload = encodeDbcMessage(message, { Counter: 4660 });
  assert.equal(payloadHex(payload), "3412");
  assert.equal(decodeDbcMessage(message, "3412").fields[0].result, "4660");
});

test("rejects definitions that could produce misleading packets", () => {
  const cases = [
    `BO_ 2048 Extended: 1 Lab\n SG_ Value : 0|8@1+ (1,0) [0|255] "" Lab`,
    `BO_ 386 BuiltInDynamics: 1 Lab\n SG_ Value : 0|8@1+ (1,0) [0|255] "" Lab`,
    `BO_ 100 TooLong: 9 Lab\n SG_ Value : 0|8@1+ (1,0) [0|255] "" Lab`,
    `BO_ 100 Bits: 2 Lab\n SG_ Value : 1|12@1+ (1,0) [0|255] "" Lab`,
    `BO_ 100 Mux: 2 Lab\n SG_ Mode M : 0|8@1+ (1,0) [0|255] "" Lab`,
    `BO_ 100 Overlap: 2 Lab\n SG_ First : 0|16@1+ (1,0) [0|255] "" Lab\n SG_ Second : 0|8@1+ (1,0) [0|255] "" Lab`,
    `BO_ 100 Range: 1 Lab\n SG_ Value : 0|8@1+ (1,0) [10|-10] "" Lab`,
    `BO_ 100 Names: 2 Lab\n SG_ Value : 0|8@1+ (1,0) [0|255] "" Lab\n SG_ Value : 8|8@1+ (1,0) [0|255] "" Lab`,
  ];
  for (const source of cases) {
    const result = parseDbc(source);
    assert.equal(result.catalog, null);
    assert.ok(result.errors.length > 0);
  }
});

test("rejects physical values outside declared or representable ranges", () => {
  const message = parseDbc(OPEN_ECU_DBC_EXAMPLE).catalog!.messages[0];
  assert.throws(() => encodeDbcMessage(message, { CoolantTemperature: 151 }), /between -40 and 150/);
  assert.throws(() => encodeDbcMessage(message, { CoolantTemperature: 0.05 }), /cannot be represented/);
  assert.equal(decodeDbcMessage(message, "00").fields.length, 0);
});
