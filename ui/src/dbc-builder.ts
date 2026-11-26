export type SignalDraft = {
  key: string;
  name: string;
  startByte: string;
  widthBytes: string;
  byteOrder: "little_endian" | "big_endian";
  signed: boolean;
  factor: string;
  offset: string;
  min: string;
  max: string;
  unit: string;
};

export type MessageDraft = {
  id: string;
  name: string;
  length: string;
  transmitter: string;
  signals: SignalDraft[];
};

export type BuiltDbcMessage = { source: string; errors: string[] };

const RESERVED_LAB_IDS = new Set([0x181, 0x182, 0x183, 0x280, 0x510, 0x6a0, 0x6a8, 0x361, 0x362]);
const dbcName = /^[A-Za-z_]\w*$/;

export function newSignalDraft(index: number, startByte = 0): SignalDraft {
  return {
    key: `signal-${Date.now()}-${index}`,
    name: index === 1 ? "VehicleSpeed" : `Signal${index}`,
    startByte: String(startByte),
    widthBytes: "2",
    byteOrder: "big_endian",
    signed: false,
    factor: "0.01",
    offset: "0",
    min: "0",
    max: "250",
    unit: index === 1 ? "km/h" : "",
  };
}

export function newMessageDraft(): MessageDraft {
  return {
    id: "0x540",
    name: "StudentTelemetry",
    length: "8",
    transmitter: "Lab",
    signals: [newSignalDraft(1)],
  };
}

export function parseDraftCanId(value: string) {
  const trimmed = value.trim();
  if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(trimmed)) return null;
  const id = Number.parseInt(trimmed, trimmed.toLowerCase().startsWith("0x") ? 16 : 10);
  return Number.isSafeInteger(id) ? id : null;
}

function draftNumber(value: string) {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function signalByteRange(signal: SignalDraft) {
  const start = Number(signal.startByte);
  const width = Number(signal.widthBytes);
  return { start, end: start + width - 1 };
}

export function byteAssignments(draft: MessageDraft) {
  const length = Number(draft.length);
  return Array.from({ length: Number.isInteger(length) && length > 0 ? Math.min(length, 8) : 0 }, (_, byte) =>
    draft.signals.filter(signal => {
      const range = signalByteRange(signal);
      return Number.isInteger(range.start) && Number.isInteger(range.end) && byte >= range.start && byte <= range.end;
    }).map(signal => signal.name || "Unnamed"),
  );
}

export function buildDbcMessage(draft: MessageDraft, existingIds: number[] = []): BuiltDbcMessage {
  const errors: string[] = [];
  const id = parseDraftCanId(draft.id);
  const length = Number(draft.length);
  if (id === null || id < 0 || id > 0x7ff) errors.push("CAN ID must be a standard identifier from 0x000 to 0x7FF.");
  else if (RESERVED_LAB_IDS.has(id)) errors.push(`${draft.id.toUpperCase()} is reserved by the built-in lab protocol.`);
  else if (existingIds.includes(id)) errors.push(`${draft.id.toUpperCase()} already exists in the current DBC.`);
  if (!dbcName.test(draft.name)) errors.push("Message name must start with a letter or underscore and contain only letters, numbers, and underscores.");
  if (!dbcName.test(draft.transmitter)) errors.push("Transmitter must be a valid DBC name.");
  if (!Number.isInteger(length) || length < 1 || length > 8) errors.push("Payload length must be between 1 and 8 bytes.");
  if (!draft.signals.length) errors.push("Add at least one signal to the message.");

  const names = new Set<string>();
  const occupied = new Map<number, string>();
  for (const [index, signal] of draft.signals.entries()) {
    const label = signal.name || `Signal ${index + 1}`;
    const width = Number(signal.widthBytes);
    const start = Number(signal.startByte);
    const factor = draftNumber(signal.factor);
    const offset = draftNumber(signal.offset);
    const min = draftNumber(signal.min);
    const max = draftNumber(signal.max);
    if (!dbcName.test(signal.name)) errors.push(`${label}: name must be a valid DBC name.`);
    else if (names.has(signal.name)) errors.push(`${label}: signal names must be unique.`);
    names.add(signal.name);
    if (!Number.isInteger(start) || start < 0 || start > 7) errors.push(`${label}: start byte must be from 0 to 7.`);
    if (![1, 2, 3, 4].includes(width)) errors.push(`${label}: width must be 1, 2, 3, or 4 bytes.`);
    if (Number.isInteger(start) && [1, 2, 3, 4].includes(width) && start + width > length) {
      errors.push(`${label}: bytes B${start}–B${start + width - 1} exceed the ${length}-byte payload.`);
    }
    if (factor === null || factor === 0) errors.push(`${label}: factor must be a non-zero number.`);
    if (offset === null) errors.push(`${label}: offset must be a number.`);
    if (min === null || max === null || (min !== null && max !== null && min > max)) errors.push(`${label}: enter a valid minimum and maximum.`);
    if (signal.unit.includes('"')) errors.push(`${label}: unit cannot contain a quotation mark.`);

    if (Number.isInteger(start) && [1, 2, 3, 4].includes(width)) {
      for (let byte = start; byte < start + width && byte < length; byte++) {
        const previous = occupied.get(byte);
        if (previous) errors.push(`${label}: byte B${byte} is already assigned to ${previous}.`);
        else occupied.set(byte, label);
      }
    }

    if (factor !== null && factor !== 0 && offset !== null && min !== null && max !== null && [1, 2, 3, 4].includes(width)) {
      const bits = width * 8;
      const rawMin = signal.signed ? -(2 ** (bits - 1)) : 0;
      const rawMax = signal.signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1;
      const physicalEnds = [rawMin * factor + offset, rawMax * factor + offset];
      const physicalMin = Math.min(...physicalEnds);
      const physicalMax = Math.max(...physicalEnds);
      if (min < physicalMin || max > physicalMax) {
        errors.push(`${label}: declared range exceeds the representable ${bits}-bit range (${physicalMin} to ${physicalMax}).`);
      }
    }
  }

  if (errors.length || id === null) return { source: "", errors };
  const lines = [`BO_ ${id} ${draft.name}: ${length} ${draft.transmitter}`];
  for (const signal of draft.signals) {
    const startByte = Number(signal.startByte);
    const startBit = signal.byteOrder === "little_endian" ? startByte * 8 : startByte * 8 + 7;
    const order = signal.byteOrder === "little_endian" ? "1" : "0";
    lines.push(` SG_ ${signal.name} : ${startBit}|${Number(signal.widthBytes) * 8}@${order}${signal.signed ? "-" : "+"} (${signal.factor},${signal.offset}) [${signal.min}|${signal.max}] "${signal.unit}" ${draft.transmitter}`);
  }
  return { source: lines.join("\n"), errors };
}

export function appendDbcMessage(existingSource: string, messageSource: string) {
  const base = existingSource.trim() || `VERSION "Open ECU Studio visual builder"\n\nNS_ :\n\nBS_:\n\nBU_: Lab`;
  return `${base}\n\n${messageSource.trim()}\n`;
}
