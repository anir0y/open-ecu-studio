import type { Field, Packet } from "./packets";

export type DbcByteOrder = "little_endian" | "big_endian";

export type DbcSignal = {
  name: string;
  startBit: number;
  length: number;
  byteOrder: DbcByteOrder;
  signed: boolean;
  factor: number;
  offset: number;
  min: number;
  max: number;
  unit: string;
};

export type DbcMessage = {
  id: number;
  idHex: string;
  name: string;
  length: number;
  transmitter: string;
  signals: DbcSignal[];
};

export type DbcCatalog = {
  filename: string;
  source: string;
  messages: DbcMessage[];
};

export type DbcParseResult = { catalog: DbcCatalog | null; errors: string[] };

const STORAGE_KEY = "open-ecu-studio.dbc.v1";
const RESERVED_LAB_IDS = new Set([0x181, 0x182, 0x183, 0x280, 0x510, 0x6a0, 0x6a8, 0x361, 0x362]);
const numberPattern = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?";
const signalPattern = new RegExp(
  `^SG_\\s+([A-Za-z_]\\w*)(?:\\s+([mM]\\d*))?\\s*:\\s*(\\d+)\\|(\\d+)@([01])([+-])\\s+\\((${numberPattern}),(${numberPattern})\\)\\s+\\[(${numberPattern})\\|(${numberPattern})\\]\\s+"([^"]*)"`,
);

export const OPEN_ECU_DBC_EXAMPLE = `VERSION "Open ECU Studio teaching subset"

NS_ :

BS_:

BU_: Lab

BO_ 1312 BenchTemperature: 2 Lab
 SG_ CoolantTemperature : 7|16@0- (0.1,0) [-40|150] "deg C" Lab
`;

function idHex(id: number) {
  return `0x${id.toString(16).toUpperCase().padStart(3, "0")}`;
}

function signalByteRange(signal: DbcSignal) {
  const start = Math.floor(signal.startBit / 8);
  return { start, end: start + signal.length / 8 - 1 };
}

function finiteNumber(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseDbc(source: string, filename = "signals.dbc"): DbcParseResult {
  const errors: string[] = [];
  const messages: DbcMessage[] = [];
  let current: DbcMessage | null = null;

  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = raw.trim();
    if (!line) continue;
    const messageMatch = /^BO_\s+(\d+)\s+([A-Za-z_]\w*)\s*:\s*(\d+)\s+(\S+)/.exec(line);
    if (messageMatch) {
      const id = Number(messageMatch[1]);
      const length = Number(messageMatch[3]);
      current = null;
      if (!Number.isSafeInteger(id) || id < 0 || id > 0x7ff) {
        errors.push(`Line ${lineNumber}: only standard 11-bit CAN identifiers (0x000-0x7FF) are supported.`);
        continue;
      }
      if (RESERVED_LAB_IDS.has(id)) {
        errors.push(`Line ${lineNumber}: ${idHex(id)} is reserved by the built-in Open ECU Studio lab protocol.`);
        continue;
      }
      if (!Number.isInteger(length) || length < 1 || length > 8) {
        errors.push(`Line ${lineNumber}: ${messageMatch[2]} must use 1-8 Classical CAN bytes.`);
        continue;
      }
      if (messages.some(message => message.id === id)) {
        errors.push(`Line ${lineNumber}: duplicate message identifier ${idHex(id)}.`);
        continue;
      }
      current = { id, idHex: idHex(id), name: messageMatch[2], length, transmitter: messageMatch[4], signals: [] };
      messages.push(current);
      continue;
    }
    if (!line.startsWith("SG_")) continue;
    if (!current) {
      errors.push(`Line ${lineNumber}: signal has no valid message definition.`);
      continue;
    }
    const match = signalPattern.exec(line);
    if (!match) {
      errors.push(`Line ${lineNumber}: unsupported or malformed signal definition.`);
      continue;
    }
    if (match[2]) {
      errors.push(`Line ${lineNumber}: multiplexed signals are not supported in this teaching subset.`);
      continue;
    }
    const startBit = Number(match[3]);
    const length = Number(match[4]);
    const byteOrder: DbcByteOrder = match[5] === "1" ? "little_endian" : "big_endian";
    const factor = finiteNumber(match[7]);
    const offset = finiteNumber(match[8]);
    const min = finiteNumber(match[9]);
    const max = finiteNumber(match[10]);
    const alignment = byteOrder === "little_endian" ? startBit % 8 === 0 : startBit % 8 === 7;
    if (!alignment || length % 8 !== 0 || length < 8 || length > 32) {
      errors.push(`Line ${lineNumber}: ${match[1]} must be a byte-aligned 8, 16, 24, or 32-bit integer signal.`);
      continue;
    }
    if ([factor, offset, min, max].some(value => value === null) || factor === 0) {
      errors.push(`Line ${lineNumber}: ${match[1]} has invalid scaling or range values.`);
      continue;
    }
    if (min! > max!) {
      errors.push(`Line ${lineNumber}: ${match[1]} has a minimum greater than its maximum.`);
      continue;
    }
    if (current.signals.some(signal => signal.name === match[1])) {
      errors.push(`Line ${lineNumber}: duplicate signal name ${match[1]} in ${current.name}.`);
      continue;
    }
    const signal: DbcSignal = {
      name: match[1], startBit, length, byteOrder, signed: match[6] === "-",
      factor: factor!, offset: offset!, min: min!, max: max!, unit: match[11],
    };
    const range = signalByteRange(signal);
    if (range.end >= current.length) {
      errors.push(`Line ${lineNumber}: ${signal.name} extends beyond the ${current.length}-byte message.`);
      continue;
    }
    if (current.signals.some(existing => {
      const occupied = signalByteRange(existing);
      return range.start <= occupied.end && range.end >= occupied.start;
    })) {
      errors.push(`Line ${lineNumber}: ${signal.name} overlaps another signal; multiplexing is not inferred.`);
      continue;
    }
    current.signals.push(signal);
  }

  if (!messages.length) errors.push("No supported BO_ message definitions were found.");
  for (const message of messages) {
    if (!message.signals.length) errors.push(`${message.idHex} ${message.name} has no supported signals.`);
  }
  return { catalog: errors.length ? null : { filename, source, messages }, errors };
}

function rawLimits(signal: DbcSignal) {
  if (signal.signed) {
    return { min: -(2 ** (signal.length - 1)), max: 2 ** (signal.length - 1) - 1 };
  }
  return { min: 0, max: 2 ** signal.length - 1 };
}

function signalPrecision(signal: DbcSignal) {
  const text = String(signal.factor);
  if (text.includes("e-")) return Math.min(8, Number(text.split("e-")[1]));
  return Math.min(8, text.split(".")[1]?.length ?? 0);
}

function physicalText(value: number, signal: DbcSignal) {
  return value.toFixed(signalPrecision(signal)).replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
}

function bytesForSignal(payload: Uint8Array, signal: DbcSignal) {
  const { start, end } = signalByteRange(signal);
  return payload.slice(start, end + 1);
}

function rawFromBytes(bytes: Uint8Array, signal: DbcSignal) {
  const ordered = signal.byteOrder === "little_endian" ? [...bytes].reverse() : [...bytes];
  let raw = 0n;
  for (const byte of ordered) raw = (raw << 8n) | BigInt(byte);
  if (signal.signed && (raw & (1n << BigInt(signal.length - 1)))) raw -= 1n << BigInt(signal.length);
  return Number(raw);
}

export function encodeDbcMessage(message: DbcMessage, values: Record<string, number>): Uint8Array {
  const payload = new Uint8Array(message.length);
  for (const signal of message.signals) {
    const value = values[signal.name];
    if (!Number.isFinite(value)) throw new Error(`${signal.name} requires a finite physical value.`);
    if (signal.min < signal.max && (value < signal.min || value > signal.max)) {
      throw new Error(`${signal.name} must be between ${signal.min} and ${signal.max} ${signal.unit}.`);
    }
    const rawFloat = (value - signal.offset) / signal.factor;
    const raw = Math.round(rawFloat);
    if (Math.abs(rawFloat - raw) > 1e-7) throw new Error(`${signal.name} cannot be represented at a ${signal.factor} scale.`);
    const limits = rawLimits(signal);
    if (raw < limits.min || raw > limits.max) throw new Error(`${signal.name} exceeds its ${signal.length}-bit raw range.`);
    let encoded = BigInt(raw);
    if (encoded < 0) encoded += 1n << BigInt(signal.length);
    const width = signal.length / 8;
    const bytes = new Uint8Array(width);
    for (let index = width - 1; index >= 0; index--) {
      bytes[index] = Number(encoded & 0xffn);
      encoded >>= 8n;
    }
    const { start } = signalByteRange(signal);
    payload.set(signal.byteOrder === "little_endian" ? bytes.reverse() : bytes, start);
  }
  return payload;
}

export function payloadHex(payload: Uint8Array) {
  return [...payload].map(byte => byte.toString(16).toUpperCase().padStart(2, "0")).join("");
}

export function decodeDbcMessage(message: DbcMessage, hex: string): { fields: Field[]; note: string } {
  const normalized = hex.replace(/\s+/g, "").toUpperCase();
  if (!/^(?:[0-9A-F]{2})+$/.test(normalized)) return { fields: [], note: "Invalid or empty hex payload." };
  if (normalized.length !== message.length * 2) {
    return { fields: [], note: `Expected ${message.length} bytes for ${message.idHex} ${message.name}.` };
  }
  const payload = Uint8Array.from(normalized.match(/.{2}/g)!.map(byte => Number.parseInt(byte, 16)));
  const fields = message.signals.map(signal => {
    const range = signalByteRange(signal);
    const bytes = bytesForSignal(payload, signal);
    const raw = rawFromBytes(bytes, signal);
    const physical = raw * signal.factor + signal.offset;
    const order = signal.byteOrder === "little_endian" ? "Intel" : "Motorola";
    return {
      start: range.start, end: range.end, name: signal.name,
      hex: [...bytes].map(byte => byte.toString(16).toUpperCase().padStart(2, "0")).join(" "),
      rule: `${signal.signed ? "int" : "uint"}${signal.length} ${order} · raw ${raw} × ${signal.factor} + ${signal.offset}`,
      result: physicalText(physical, signal), unit: signal.unit,
    };
  });
  return { fields, note: `Decoded with imported DBC definition ${message.idHex} ${message.name}. No frame was transmitted.` };
}

export function packetForDbc(message: DbcMessage, values: Record<string, number>): Packet {
  return { id: message.idHex, data: payloadHex(encodeDbcMessage(message, values)), is_fd: false, is_extended_id: false };
}

export function findDbcMessage(messages: DbcMessage[], packet: Packet) {
  const id = Number.parseInt(packet.id.replace(/^0x/i, ""), 16);
  return messages.find(message => message.id === id && message.length * 2 === packet.data.replace(/\s+/g, "").length);
}

export function defaultSignalValues(message: DbcMessage) {
  return Object.fromEntries(message.signals.map(signal => {
    const preferred = signal.min <= 0 && signal.max >= 0 ? 0 : signal.min;
    const raw = Math.round((preferred - signal.offset) / signal.factor);
    return [signal.name, raw * signal.factor + signal.offset];
  }));
}

export function saveDbcCatalog(catalog: DbcCatalog | null) {
  try {
    if (catalog) localStorage.setItem(STORAGE_KEY, JSON.stringify({ filename: catalog.filename, source: catalog.source }));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable in private or embedded browser contexts; the in-memory catalog still works.
  }
}

export function loadDbcCatalog(): DbcCatalog | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    const value = JSON.parse(stored) as { filename?: unknown; source?: unknown };
    if (typeof value.filename !== "string" || typeof value.source !== "string") return null;
    return parseDbc(value.source, value.filename).catalog;
  } catch {
    return null;
  }
}

function csvRows(rows: (string | number)[][]) {
  return rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\r\n") + "\r\n";
}

export function dbcWorksheetCsv(message: DbcMessage, hex: string) {
  const decoded = decodeDbcMessage(message, hex);
  return csvRows([
    ["can_id", "message", "payload_hex", "byte_order", "signal", "byte_start", "byte_end", "decode", "value", "unit"],
    ...decoded.fields.map((field, index) => [
      message.idHex, message.name, hex, message.signals[index].byteOrder, field.name,
      field.start, field.end, field.rule, field.result, field.unit,
    ]),
  ]);
}
