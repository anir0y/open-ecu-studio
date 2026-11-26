import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";

import { DbcBuilder } from "./DbcBuilder";
import {
  OPEN_ECU_DBC_EXAMPLE,
  dbcWorksheetCsv,
  decodeDbcMessage,
  defaultSignalValues,
  packetForDbc,
  parseDbc,
  saveDbcCatalog,
  type DbcCatalog,
  type DbcMessage,
} from "./dbc";
import { downloadCsv } from "./download-csv";
import { spacedHex, type Packet } from "./packets";

type Props = {
  catalog: DbcCatalog | null;
  onCatalogChange: (catalog: DbcCatalog | null) => void;
  onInspect: (packet: Packet) => void;
};

function valuesFor(message: DbcMessage | undefined) {
  if (!message) return {};
  return Object.fromEntries(Object.entries(defaultSignalValues(message)).map(([name, value]) => [name, String(value)]));
}

export function DbcWorkspace({ catalog, onCatalogChange, onInspect }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState(catalog?.source ?? "");
  const [filename, setFilename] = useState(catalog?.filename ?? "signals.dbc");
  const [messageId, setMessageId] = useState(catalog?.messages[0]?.idHex ?? "");
  const message = catalog?.messages.find(item => item.idHex === messageId) ?? catalog?.messages[0];
  const [values, setValues] = useState<Record<string, string>>(() => valuesFor(message));
  const [rawHex, setRawHex] = useState("");
  const [notice, setNotice] = useState(catalog ? `${catalog.messages.length} message definition${catalog.messages.length === 1 ? "" : "s"} restored locally.` : "Import a DBC file or load the teaching example.");
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    const next = catalog?.messages.find(item => item.idHex === messageId) ?? catalog?.messages[0];
    if (next && next.idHex !== messageId) setMessageId(next.idHex);
    setValues(valuesFor(next));
  }, [catalog, messageId]);

  const preview = useMemo(() => {
    if (!message) return { packet: null, error: "" };
    try {
      return {
        packet: packetForDbc(message, Object.fromEntries(message.signals.map(signal => [
          signal.name,
          values[signal.name]?.trim() === "" ? Number.NaN : Number(values[signal.name]),
        ]))),
        error: "",
      };
    } catch (cause) {
      return { packet: null, error: cause instanceof Error ? cause.message : "Unable to encode this message." };
    }
  }, [message, values]);

  useEffect(() => {
    if (preview.packet) setRawHex(preview.packet.data);
  }, [preview.packet?.data]);

  const decoded = message ? decodeDbcMessage(message, rawHex) : { fields: [], note: "" };

  function applySource(nextSource: string, nextFilename: string) {
    setSource(nextSource);
    setFilename(nextFilename);
    const result = parseDbc(nextSource, nextFilename);
    setErrors(result.errors);
    if (!result.catalog) {
      setNotice("Nothing was saved. Correct the definitions below and validate again.");
      return;
    }
    saveDbcCatalog(result.catalog);
    onCatalogChange(result.catalog);
    setMessageId(result.catalog.messages[0].idHex);
    setNotice(`${result.catalog.messages.length} message definition${result.catalog.messages.length === 1 ? "" : "s"} validated and saved in this browser.`);
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    applySource(await file.text(), file.name);
    event.target.value = "";
  }

  function clearCatalog() {
    saveDbcCatalog(null);
    onCatalogChange(null);
    setSource("");
    setFilename("signals.dbc");
    setMessageId("");
    setValues({});
    setRawHex("");
    setErrors([]);
    setNotice("Local DBC definitions cleared. Built-in lab signals are unchanged.");
  }

  function inspect() {
    if (!message || !rawHex || decoded.fields.length === 0) return;
    onInspect({ id: message.idHex, data: rawHex.replace(/\s+/g, "").toUpperCase(), is_fd: false, is_extended_id: false });
    location.hash = "packet-lesson";
  }

  return <section className="dbc-workspace" id="dbc-workspace" aria-labelledby="dbc-title">
    <header className="dbc-heading">
      <div><span>Signal definitions</span><h2 id="dbc-title">DBC workbench</h2><p>Define synthetic Classical CAN frames, verify their bytes, then inspect them in the classroom.</p></div>
      <div className="dbc-safety"><i />Local preview only<strong>No adapter transmission</strong></div>
    </header>

    <div className="dbc-import">
      <div className="dbc-actions">
        <input ref={fileInput} type="file" accept=".dbc,text/plain" onChange={importFile} hidden />
        <button className="dbc-primary" onClick={() => fileInput.current?.click()}>Import DBC file</button>
        <button onClick={() => applySource(OPEN_ECU_DBC_EXAMPLE, "open-ecu-teaching.dbc")}>Load teaching example</button>
        {catalog && <button className="dbc-clear" onClick={clearCatalog}>Clear local DBC</button>}
      </div>
      <p className={errors.length ? "dbc-notice error" : "dbc-notice"} role="status">{notice}</p>
      {errors.length > 0 && <ul className="dbc-errors">{errors.slice(0, 6).map(error => <li key={error}>{error}</li>)}</ul>}
      <DbcBuilder existingSource={catalog?.source ?? ""} existingIds={catalog?.messages.map(message => message.id) ?? []}
        onCreate={nextSource => applySource(nextSource, catalog?.filename ?? "visual-signals.dbc")} />
      <details className="dbc-source">
        <summary>Edit or paste DBC source <span>{filename}</span></summary>
        <textarea aria-label="DBC source" value={source} spellCheck={false} onChange={event => setSource(event.target.value)} placeholder="BO_ 1312 MessageName: 2 Lab&#10; SG_ SignalName : 7|16@0- (0.1,0) [-40|150] &quot;deg C&quot; Lab" />
        <button onClick={() => applySource(source, filename)}>Validate and save</button>
      </details>
    </div>

    {catalog && message && <div className="dbc-lab">
      <div className="dbc-definition">
        <label>Message definition<select value={message.idHex} onChange={event => setMessageId(event.target.value)}>
          {catalog.messages.map(item => <option key={item.idHex} value={item.idHex}>{item.idHex} · {item.name} · {item.length} bytes</option>)}
        </select></label>
        <dl><div><dt>Transmitter</dt><dd>{message.transmitter}</dd></div><div><dt>Signals</dt><dd>{message.signals.length}</dd></div><div><dt>Bus format</dt><dd>11-bit CAN</dd></div></dl>
        <div className="dbc-value-grid">{message.signals.map(signal => <label key={signal.name}>
          <span>{signal.name}<small>{signal.min}–{signal.max} {signal.unit}</small></span>
          <input type="number" step={Math.abs(signal.factor)} value={values[signal.name] ?? ""} onChange={event => setValues(current => ({ ...current, [signal.name]: event.target.value }))} />
        </label>)}</div>
        {preview.error && <p className="dbc-inline-error" role="alert">{preview.error}</p>}
      </div>

      <div className="dbc-packet">
        <div className="dbc-packet-title"><span>Packet preview</span><strong>{message.idHex}</strong><small>{message.length} bytes</small></div>
        <label>Editable payload<input className="dbc-hex-input" value={spacedHex(rawHex.replace(/\s+/g, "").toUpperCase())} onChange={event => setRawHex(event.target.value)} spellCheck={false} /></label>
        <div className="dbc-byte-preview">{rawHex.replace(/\s+/g, "").match(/.{1,2}/g)?.map((byte, index) => <span key={index}><small>B{index}</small><code>{byte.toUpperCase()}</code></span>)}</div>
        <p>{decoded.note || "Enter a complete payload to decode it."}</p>
        <div className="dbc-packet-actions">
          <button className="dbc-primary" disabled={!decoded.fields.length} onClick={inspect}>Inspect in classroom</button>
          <button disabled={!decoded.fields.length} onClick={event => message && downloadCsv(`dbc-${message.idHex}-${message.name}.csv`, dbcWorksheetCsv(message, rawHex), event.currentTarget.ownerDocument)}>Download worksheet</button>
        </div>
      </div>
    </div>}

    <footer>Supported now: standard 11-bit identifiers · 1–8 byte Classical CAN · byte-aligned 8–32 bit integers · Intel and Motorola order · signed values · scale, offset, range, and unit.</footer>
  </section>;
}
