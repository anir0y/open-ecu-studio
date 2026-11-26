import { useMemo, useState } from "react";

import {
  appendDbcMessage,
  buildDbcMessage,
  byteAssignments,
  newMessageDraft,
  newSignalDraft,
  type MessageDraft,
  type SignalDraft,
} from "./dbc-builder";

type Props = {
  existingSource: string;
  existingIds: number[];
  onCreate: (source: string) => void;
};

function updateSignal(draft: MessageDraft, key: string, change: Partial<SignalDraft>): MessageDraft {
  return { ...draft, signals: draft.signals.map(signal => signal.key === key ? { ...signal, ...change } : signal) };
}

export function DbcBuilder({ existingSource, existingIds, onCreate }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(newMessageDraft);
  const [errors, setErrors] = useState<string[]>([]);
  const assignments = useMemo(() => byteAssignments(draft), [draft]);

  function addSignal() {
    const freeByte = assignments.findIndex(signals => signals.length === 0);
    if (freeByte < 0) {
      setErrors(["All payload bytes are assigned. Increase the payload length or resize a signal."]);
      return;
    }
    const next = newSignalDraft(draft.signals.length + 1, freeByte);
    if (freeByte === Number(draft.length) - 1) next.widthBytes = "1";
    setDraft(current => ({ ...current, signals: [...current.signals, next] }));
    setErrors([]);
  }

  function createMessage() {
    const result = buildDbcMessage(draft, existingIds);
    setErrors(result.errors);
    if (result.errors.length) return;
    onCreate(appendDbcMessage(existingSource, result.source));
    setDraft(newMessageDraft());
    setOpen(false);
  }

  return <div className={`dbc-builder${open ? " open" : ""}`}>
    <button className="dbc-builder-toggle" aria-expanded={open} onClick={() => {
      setOpen(current => !current);
      setErrors([]);
    }}><span><strong>Build a message visually</strong><small>Place signals directly onto a Classical CAN payload</small></span><i>{open ? "Close" : "Open builder"}</i></button>

    {open && <div className="dbc-builder-body">
      <div className="dbc-builder-identity">
        <label>CAN identifier<input aria-label="Visual message CAN identifier" value={draft.id} onChange={event => setDraft({ ...draft, id: event.target.value })} /></label>
        <label>Message name<input aria-label="Visual message name" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
        <label>Payload<select aria-label="Visual message payload length" value={draft.length} onChange={event => setDraft({ ...draft, length: event.target.value })}>
          {Array.from({ length: 8 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1} byte{index ? "s" : ""}</option>)}
        </select></label>
        <label>Transmitter<input aria-label="Visual message transmitter" value={draft.transmitter} onChange={event => setDraft({ ...draft, transmitter: event.target.value })} /></label>
      </div>

      <div className="dbc-payload-bench" aria-label="Payload byte assignments">
        {assignments.map((signals, byte) => <div key={byte} className={signals.length > 1 ? "collision" : signals.length ? "assigned" : ""}>
          <small>B{byte}</small><strong>{signals.length ? signals.join(" + ") : "Free"}</strong>
        </div>)}
      </div>

      <div className="dbc-signal-list">{draft.signals.map((signal, index) => <fieldset key={signal.key}>
        <legend><span>Signal {index + 1}</span><strong>{signal.name || "Unnamed"}</strong>{draft.signals.length > 1 && <button onClick={() => {
          setDraft(current => ({ ...current, signals: current.signals.filter(item => item.key !== signal.key) }));
          setErrors([]);
        }}>Remove</button>}</legend>
        <div className="dbc-signal-grid">
          <label className="wide">Name<input aria-label={`Signal ${index + 1} name`} value={signal.name} onChange={event => setDraft(updateSignal(draft, signal.key, { name: event.target.value }))} /></label>
          <label>Start byte<select aria-label={`Signal ${index + 1} start byte`} value={signal.startByte} onChange={event => setDraft(updateSignal(draft, signal.key, { startByte: event.target.value }))}>
            {assignments.map((_, byte) => <option key={byte} value={byte}>B{byte}</option>)}
          </select></label>
          <label>Width<select aria-label={`Signal ${index + 1} width`} value={signal.widthBytes} onChange={event => setDraft(updateSignal(draft, signal.key, { widthBytes: event.target.value }))}>
            {[1, 2, 3, 4].map(width => <option key={width} value={width}>{width} byte{width > 1 ? "s" : ""}</option>)}
          </select></label>
          <label>Byte order<select aria-label={`Signal ${index + 1} byte order`} value={signal.byteOrder} onChange={event => setDraft(updateSignal(draft, signal.key, { byteOrder: event.target.value as SignalDraft["byteOrder"] }))}>
            <option value="big_endian">Motorola</option><option value="little_endian">Intel</option>
          </select></label>
          <label className="dbc-signed"><span>Signed value</span><input aria-label={`Signal ${index + 1} signed`} type="checkbox" checked={signal.signed} onChange={event => setDraft(updateSignal(draft, signal.key, { signed: event.target.checked }))} /></label>
          <label>Factor<input aria-label={`Signal ${index + 1} factor`} type="number" value={signal.factor} onChange={event => setDraft(updateSignal(draft, signal.key, { factor: event.target.value }))} /></label>
          <label>Offset<input aria-label={`Signal ${index + 1} offset`} type="number" value={signal.offset} onChange={event => setDraft(updateSignal(draft, signal.key, { offset: event.target.value }))} /></label>
          <label>Minimum<input aria-label={`Signal ${index + 1} minimum`} type="number" value={signal.min} onChange={event => setDraft(updateSignal(draft, signal.key, { min: event.target.value }))} /></label>
          <label>Maximum<input aria-label={`Signal ${index + 1} maximum`} type="number" value={signal.max} onChange={event => setDraft(updateSignal(draft, signal.key, { max: event.target.value }))} /></label>
          <label>Unit<input aria-label={`Signal ${index + 1} unit`} value={signal.unit} onChange={event => setDraft(updateSignal(draft, signal.key, { unit: event.target.value }))} /></label>
        </div>
      </fieldset>)}</div>

      {errors.length > 0 && <div className="dbc-builder-errors" role="alert"><strong>Message not created</strong><ul>{errors.map(error => <li key={error}>{error}</li>)}</ul></div>}
      <div className="dbc-builder-actions"><button onClick={addSignal}>Add signal</button><button className="dbc-primary" onClick={createMessage}>Create and save message</button></div>
    </div>}
  </div>;
}
