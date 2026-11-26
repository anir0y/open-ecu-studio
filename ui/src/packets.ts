import type { Exercise, ExerciseAction, ExerciseCar } from "./receiver-exercise";
import { decodeDbcMessage, type DbcMessage } from "./dbc.ts";

export const frameNames: Record<string, string> = {
  "0x181": "Wheel speeds", "0x182": "ESC dynamics", "0x183": "Vehicle state",
  "0x280": "ECU status", "0x510": "FD telemetry", "0x6A0": "UDS request", "0x6A8": "UDS response",
  "0x361": "Body controller", "0x362": "Fob receiver decision",
};

export function frameName(id: string, customMessages: DbcMessage[] = []) {
  const numericId = Number.parseInt(id.replace(/^0x/i, ""), 16);
  return frameNames[id] ?? customMessages.find(message => message.id === numericId)?.name ?? "Unknown";
}

export type Packet = {
  id: string; data: string; is_fd: boolean; is_extended_id?: boolean;
  sequence?: number; timestamp?: number;
};

type ObservedPacket = Packet & {sequence: number; timestamp: number};
export type EscEvent = {
  source: "synthetic" | "firmware";
  baseline: ObservedPacket;
  wheels: ObservedPacket;
  dynamics: ObservedPacket | null;
  esc: ObservedPacket | null;
};
export type EscCapture = {
  state: "idle" | "armed" | "collecting" | "frozen";
  event: EscEvent | null;
  complete: boolean;
};
export type EscCaptureAction = "arm" | "clear";

export const examples = [
  ["Straight ahead", "0x182", "000000000000002A"],
  ["Left turn", "0x182", "FC18FF880000002B"],
  ["Right turn", "0x182", "03E800780000002C"],
  ["Rear-left wheel slip", "0x181", "0FA00FA00BB80FA0"],
  ["Driver braking", "0x183", "0FA0FF0600285C00"],
  ["ESC active", "0x280", "0100012D00000000"],
  ["CAN FD sample", "0x510", "000003E80FA00FA00BB80FA00000012D"],
  ["Software version request", "0x6A0", "0322F1A000000000"],
  ["Software version response", "0x6A8", "0562F1A001000000"],
  ["Left door and cabin light", "0x361", "0101010000010001"],
  ["Hazards and high beams", "0x361", "0203000101000002"],
  ["Fresh fob unlock", "0x362", "0100000000090003"],
  ["Duplicate unlock after cabin lock", "0x362", "0200000000090104"],
].map(([title, id, data]) => ({title, id, data, is_fd: id === "0x510"}));

export type Field = { start: number; end: number; name: string; hex: string; rule: string; result: string; unit: string };
type Spec = [name: string, width: number, divisor?: number, unit?: string, signed?: boolean];
export const escWheelFields = ["Front left", "Front right", "Rear left", "Rear right"];
const wheelFields: Spec[] = escWheelFields.map(name => [name, 2, 100, "km/h"]);
const flag: Spec = ["ESC intervention", 1];
const counter: Spec = ["Sample counter", 1];
const layouts: Record<string, Spec[]> = {
  "0x181": wheelFields,
  "0x182": [["Yaw rate", 2, 100, "°/s", true], ["Road-wheel steering", 2, 10, "°", true], ["Brake pressure", 2, 10, "bar"], flag, counter],
  "0x183": [["Vehicle speed", 2, 100, "km/h"], ["Acceleration", 2, 100, "m/s²", true], ["Throttle", 1, 1, "%"], ["Driver brake", 1, 1, "%"], ["Road grip", 1, 100, "μ"], ["Lateral load", 1, 100, "g", true]],
  "0x280": [["Version major", 1], ["Version minor", 1], flag, counter, ["Reserved", 4]],
  "0x510": [["Elapsed time", 4, 1, "ms"], ...wheelFields, ["Yaw rate", 2, 100, "°/s", true], flag, counter],
};
const services: Record<string, string> = {
  "10": "Session control", "50": "Session accepted", "3E": "Tester present", "7E": "Tester present accepted",
  "22": "Read data by identifier", "62": "Read data response", "7F": "Negative response",
};

export function decodePacket(packet: Packet, customMessage?: DbcMessage): { fields: Field[]; note: string } {
  const hex = packet.data.toUpperCase();
  const fields: Field[] = [];
  if (!/^(?:[0-9A-F]{2})+$/.test(hex)) return {fields, note: "Invalid or empty hex payload."};
  if (packet.is_extended_id) return {fields, note: "No field map for this identifier."};
  if (customMessage && !packet.is_fd) return decodeDbcMessage(customMessage, hex);
  if (!frameNames[packet.id]) return {fields, note: "No field map for this identifier."};
  const length = hex.length / 2;
  if (length !== (packet.id === "0x510" ? 16 : 8) || packet.is_fd !== (packet.id === "0x510")) {
    return {fields, note: "Frame format or payload length differs from the lab definition."};
  }
  const add = (start: number, width: number, name: string, rule: string, result: string, unit = "") => {
    fields.push({start, end: start + width - 1, name, hex: spacedHex(hex.slice(start * 2, (start + width) * 2)), rule, result, unit});
  };
  if (packet.id === "0x361" || packet.id === "0x362") {
    const value = (at: number, width = 1) => parseInt(hex.slice(at * 2, (at + width) * 2), 16);
    const choice = (at: number, name: string, labels: string[], rule?: string) =>
      add(at, 1, name, rule ?? labels.map((label, i) => i + " = " + label).join(" · "), labels[value(at)] ?? "Unknown");
    if (packet.id === "0x361") {
      choice(0, "Headlights", ["Off", "Low beam", "High beam"]);
      choice(1, "Indicators", ["Off", "Left", "Right", "Hazards"]);
      choice(2, "Door switches", ["Both closed", "Left open", "Right open", "Both open"], "Bit 0 = left open · bit 1 = right open");
      choice(3, "Central lock", ["Unlocked", "Locked"]);
      choice(4, "Wiper", ["Parked", "Sweeping"]);
      choice(5, "Cabin light", ["Off", "On"]);
      choice(6, "Control source", ["Cabin", "Key fob"]);
    } else {
      choice(0, "Receiver decision", ["Reserved", "Accepted", "Duplicate rejected", "Door open"]);
      choice(1, "Fob button", ["Unlock", "Lock"]);
      add(2, 4, "Message counter", "Unsigned 32-bit · big-endian", String(value(2, 4)));
      choice(6, "Resulting lock", ["Unlocked", "Locked"]);
    }
    add(7, 1, "Body revision", "Unsigned 8-bit · wraps after 255", String(value(7)));
    return {fields, note: packet.id === "0x361" ? "Body status after an applied command. B2 packs two independent door switches into one byte." : "The simulated receiver reports this decision on CAN. The message counter belongs to the classroom fob event."};
  }
  if (layouts[packet.id]) {
    let start = 0;
    for (const [name, width, divisor = 1, unit = "", signed = false] of layouts[packet.id]) {
      let value = parseInt(hex.slice(start * 2, (start + width) * 2), 16);
      const bits = width * 8;
      if (signed && value >= 2 ** (bits - 1)) value -= 2 ** bits;
      if (name === flag[0]) add(start, width, name, "Read bit 0", value & 1 ? "Active" : "Inactive");
      else if (name === "Reserved") add(start, width, name, "Reserved by the lab protocol", "—");
      else add(start, width, name, `${signed ? "int" : "uint"}${bits} → ${value}${divisor > 1 ? " ÷ " + divisor : ""}`, (value / divisor).toFixed(Math.log10(divisor)), unit);
      start += width;
    }
    return {fields, note: "Byte positions start at 0. Multi-byte numbers use big-endian order. Signed values use two’s complement."};
  }
  const count = parseInt(hex.slice(0, 2), 16);
  if (count < 1 || count > 7) return {fields, note: "Expected a lab ISO-TP single frame carrying 1–7 diagnostic bytes."};
  const sid = hex.slice(2, 4);
  add(0, 1, "ISO-TP length", "High nibble 0 = single frame", String(count), "UDS bytes");
  add(1, 1, "Service", "UDS service identifier", services[sid] ?? "Unknown service");
  let next = 2;
  if (["22", "62"].includes(sid) && count >= 3) {
    const did = hex.slice(4, 8);
    add(2, 2, "Data identifier", "Lab identifier", ({F1A0: "Software version", F1A1: "ESC state"} as Record<string,string>)[did] ?? did);
    next = 4;
    if (sid === "62" && count === 5 && did === "F1A0") {
      add(4, 2, "Version", "Major byte · minor byte", `${parseInt(hex.slice(8,10),16)}.${parseInt(hex.slice(10,12),16)}`);
      next = 6;
    }
    if (sid === "62" && count === 5 && did === "F1A1") {
      add(4, 1, "ESC intervention", "Read bit 0", parseInt(hex.slice(8,10),16) & 1 ? "Active" : "Inactive");
      add(5, 1, "Session", "Session identifier", "0x" + hex.slice(10,12));
      next = 6;
    }
  } else if (sid === "7F" && count === 3) {
    add(2, 1, "Rejected service", "Original request", "0x" + hex.slice(4,6));
    add(3, 1, "Response code", "UDS negative response code", hex.slice(6,8) === "11" ? "Service not supported" : "0x" + hex.slice(6,8));
    next = 4;
  }
  if (next <= count) add(next, count + 1 - next, "Service parameters", "Bytes following the service", spacedHex(hex.slice(next * 2, (count + 1) * 2)));
  if (count < 7) add(count + 1, 7 - count, "Padding", "Outside ISO-TP length", "Ignored");
  return {fields, note: "The first byte gives the UDS message length. Padding fills the remaining CAN payload."};
}

export function spacedHex(hex: string) { return hex.match(/.{1,2}/g)?.join(" ") ?? ""; }

export function worksheetCsv(packet: Packet, origin: string, customMessage?: DbcMessage) {
  const header = ["source","sequence","timestamp_unix_s","can_id","format","payload_hex","byte_start","byte_end","field","field_hex","decoding","value","unit"];
  const rows = decodePacket(packet, customMessage).fields.map(f => [origin,packet.sequence ?? "",packet.timestamp ?? "",packet.id,packet.is_fd ? "CAN FD" : "CAN",spacedHex(packet.data),f.start,f.end,f.name,f.hex,f.rule,f.result,f.unit]);
  return csvRows([header, ...rows]);
}

function csvRows(rows: (string | number)[][]): string {
  return rows.map(row => row.map(value => '"' + String(value).replaceAll('"', '""') + '"').join(",")).join("\r\n") + "\r\n";
}

// Both the inspection cards and the worksheet use these observed, decoded values.
export function escPacketReadings(frame: ObservedPacket, event: EscEvent) {
  const decoded = decodePacket(frame).fields;
  const readings: Record<string, string> = {
    "Frame sequence": String(frame.sequence),
    "Time (UTC)": new Date(frame.timestamp * 1000).toISOString(),
    "Offset from first slip (ms)": ((frame.timestamp - event.wheels.timestamp) * 1000).toFixed(3),
    "Payload (hex)": spacedHex(frame.data),
  };
  for (const field of decoded) {
    const label = field.unit ? `${field.name} (${field.unit})` : field.name;
    readings[label] = field.result;
  }
  if (readings["Sample counter"] !== undefined && event.dynamics) {
    const onsetCounter = decodePacket(event.dynamics).fields.find(field => field.name === "Sample counter");
    if (onsetCounter) readings["Counter offset (mod 256)"] = String((Number(readings["Sample counter"]) - Number(onsetCounter.result) + 256) % 256);
  }
  return readings;
}

export function escEventWorksheetCsv(event: EscEvent): string {
  const rows: (string | number)[][] = [[
    "Source", "Slip frame", "Phase", "Field", "Wheel speeds (0x181)", "Brake pressure (0x182)", "ESC status (0x280)",
  ]];
  const phases = [
    {name: "Before slip", frames: [event.baseline, null, null]},
    {name: "First slip", frames: [event.wheels, event.dynamics, event.esc]},
  ];
  for (const phase of phases) {
    const columns = phase.frames.map(frame => frame && escPacketReadings(frame, event));
    const prefix = [event.source, event.wheels.sequence, phase.name];
    rows.push([...prefix, "Packet observation", ...columns.map(col => col ? "Observed" :
      phase.name === "First slip" ? "Missing from this slip episode" : "")]);
    for (const field of ["Frame sequence", "Time (UTC)", "Offset from first slip (ms)", "Payload (hex)", "Sample counter",
      "Counter offset (mod 256)", ...escWheelFields.map(name => name + " (km/h)"), "Brake pressure (bar)", "ESC intervention"]) {
      const values = columns.map(col => col?.[field] ?? "");
      if (values.some(value => value !== "")) rows.push([...prefix, field, ...values]);
    }
  }
  return csvRows(rows);
}

const actionLabels: Record<ExerciseAction, string> = {
  press: "Press fob unlock", save: "Save packet", lock: "Lock both cars",
  old_unlock: "Try saved packet", handles: "Pull both handles", close: "Close both doors",
};

function handleResult(car: ExerciseCar, wasOpen: boolean) {
  if (wasOpen) return "Already open";
  return car.open ? "Opened" : "Stayed closed (locked)";
}

export function latestHandlePull(exercise: Exercise) {
  for (let index = exercise.history.length - 1; index >= 0; index--) {
    const step = exercise.history[index];
    if (step.lastAction === "handles") {
      const before = exercise.history[index - 1];
      return {step: step.step,
        vulnerable: handleResult(step.vulnerable, before?.vulnerable.open ?? false),
        protected: handleResult(step.protected, before?.protected.open ?? false)};
    }
  }
}

export function receiverWorksheetCsv(exercise: Exercise): string {
  const rows: (string | number)[][] = [[
    "Step", "Action", "Saved unlock packet (hex)", "Fob input used (hex)",
    "Vulnerable response 0x362 (hex)", "Protected response 0x362 (hex)",
    "Vulnerable decision", "Protected decision", "Vulnerable handle result", "Protected handle result",
    "Vulnerable lock after action", "Protected lock after action",
    "Vulnerable new body frame 0x361 (hex)", "Protected new body frame 0x361 (hex)",
  ]];
  for (const [index, state] of exercise.history.entries()) {
    const action = state.lastAction;
    if (action === "ready") continue;
    const cars = [state.vulnerable, state.protected];
    const hasFobInput = action === "press" || action === "old_unlock";
    const responses = cars.map(car => hasFobInput ? car.receipt : null);
    const previous = exercise.history[index - 1];
    rows.push([
      state.step, actionLabels[action], spacedHex(state.savedPress?.data ?? ""),
      hasFobInput ? spacedHex(state.vulnerable.receiptInput?.data ?? "") : "",
      ...responses.map(data => spacedHex(data ?? "")),
      ...responses.map(data => data ? decodePacket({id: "0x362", data, is_fd: false}).fields[0].result : ""),
      action === "handles" ? handleResult(state.vulnerable, previous?.vulnerable.open ?? false) : "",
      action === "handles" ? handleResult(state.protected, previous?.protected.open ?? false) : "",
      ...cars.map(car => car.locked ? "Locked" : "Unlocked"),
      ...cars.map(car => car.bodySent ? spacedHex(car.body) : ""),
    ]);
  }
  return csvRows(rows);
}
