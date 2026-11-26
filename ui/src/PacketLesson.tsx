import { useRef, useState } from "react";
import { ControlSlot, useControlWindow } from "./ControlWindow";
import { downloadCsv } from "./download-csv";
import { decodePacket, examples, frameNames, spacedHex, worksheetCsv, type Packet } from "./packets";

type Props = { packet: Packet; latest?: Packet; onSelect: (packet: Packet) => void };

export function PacketLesson({ packet, latest, onSelect }: Props) {
  const {detached} = useControlWindow();
  const panel = useRef<HTMLElement>(null);
  const {fields, note} = decodePacket(packet);
  const [focusName, setFocusName] = useState("Road-wheel steering");
  const focus = fields.find(field => field.name === focusName) ?? fields[0];
  const example = examples.find(item => item === packet);
  const origin = example ? `Worked example · ${example.title}` : `Captured frame #${packet.sequence}`;
  function showPacket(selected: Packet) {
    onSelect(selected);
    if (detached) panel.current?.scrollIntoView({block: "start"});
  }
  function download(owner: Document) {
    downloadCsv(`worksheet-${packet.id}-${packet.sequence ?? example?.title.replaceAll(" ", "-")}.csv`, worksheetCsv(packet, origin), owner);
  }
  return <section ref={panel} className="packet-lesson" id="packet-lesson" aria-label="Packet classroom">
    <div className="lesson-tools">
      <h2>Packet classroom</h2>
      <ControlSlot group="analysis">
        <div className="lesson-tools">
          {detached && <h2>Packet classroom</h2>}
          <label>Worked example <select aria-label="Worked example" value={example?.title ?? ""} onChange={e => {
            const selected = examples.find(item => item.title === e.target.value);
            if (selected) showPacket(selected);
          }}>
            {!example && <option value="">Captured frame</option>}
            {examples.map(item => <option key={item.title}>{item.title}</option>)}
          </select></label>
          {detached && focus && <label>Highlight signal <select value={focus.name} onChange={e => {
            setFocusName(e.target.value);
            panel.current?.scrollIntoView({block: "start"});
          }}>
            {fields.map(field => <option key={field.name}>{field.name}</option>)}
          </select></label>}
          <button disabled={!latest} onClick={() => latest && showPacket(latest)}>Capture latest {packet.id}</button>
          <button disabled={!fields.length} onClick={e => download(e.currentTarget.ownerDocument)}>Download worksheet CSV</button>
        </div>
      </ControlSlot>
    </div>
    <p className="lesson-origin">{origin} · {packet.id} · {frameNames[packet.id] ?? "Unknown identifier"} · {packet.is_fd ? "CAN FD" : "Classical CAN"} · {packet.data.length / 2} bytes</p>
    <div className="byte-strip" aria-label="Indexed payload bytes">{spacedHex(packet.data).split(" ").map((hex, i) =>
      <span key={i} className={focus && i >= focus.start && i <= focus.end ? "selected" : ""}><small>B{i}</small><code>{hex}</code></span>
    )}</div>
    <p>{note}</p>
    {focus && <div className="lesson-table-wrap"><table>
      <caption>{detached ? `Highlighted signal · ${focus.name}` : "Select a signal to highlight its bytes."}</caption>
      <thead><tr>{["Signal", "Bytes", "Hex", "Decode", "Result"].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
      <tbody>{fields.map(f => <tr key={f.start} className={focus === f ? "selected" : ""}>
        <th scope="row">{detached ? f.name : <button aria-pressed={focus === f} onClick={() => setFocusName(f.name)}>{f.name}</button>}</th>
        <td>{f.start === f.end ? f.start : `${f.start}–${f.end}`}</td>
        <td><code>{f.hex}</code></td><td>{f.rule}</td><td><strong>{f.result} {f.unit}</strong></td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
}
