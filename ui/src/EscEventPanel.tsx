import { memo, useRef, useState } from "react";
import { ControlSlot, useControlWindow } from "./ControlWindow";
import { downloadCsv } from "./download-csv";
import { escEventWorksheetCsv, escPacketReadings, escWheelFields, spacedHex,
  type EscCapture, type EscCaptureAction, type EscEvent } from "./packets";
import "./esc-event.css";

type Props = {
  capture?: EscCapture;
  connected: boolean;
  running: boolean;
  onAction: (action: EscCaptureAction) => Promise<void>;
};

const streams = [
  {key: "wheels", id: "0x181", name: "Wheel speeds", fields: escWheelFields.map(name => [name, "km/h"])},
  {key: "dynamics", id: "0x182", name: "Brake pressure", fields: [["Brake pressure", "bar"], ["ESC intervention", ""]]},
  {key: "esc", id: "0x280", name: "ESC status", fields: [["ESC intervention", ""], ["Version major", ""], ["Version minor", ""]]},
] as const;

function PacketCard({event, stream, frozen}: {event: EscEvent; stream: typeof streams[number]; frozen: boolean}) {
  const frame = event[stream.key];
  const values = frame && escPacketReadings(frame, event);
  return <article className="esc-event-card" aria-label={stream.name}>
    <h3><code>{stream.id}</code> {stream.name}</h3>
    {values ? <>
      <dl>{stream.fields.map(([name, unit]) => <div key={name}>
        <dt>{name}</dt><dd>{values[unit ? `${name} (${unit})` : name]} {unit && <small>{unit}</small>}</dd>
      </div>)}</dl>
      <code className="esc-event-hex">{values["Payload (hex)"]}</code>
      <p className="esc-event-meta">Frame #{values["Frame sequence"]} · {values["Offset from first slip (ms)"]} ms from slip
        {values["Sample counter"] && <> · Sample {values["Sample counter"]}</>}</p>
      {stream.key === "esc" && values["Counter offset (mod 256)"] && <p className="esc-event-meta">
        Counter offset from dynamics +{values["Counter offset (mod 256)"]} (mod 256)</p>}
    </> : <p>{frozen ? "No packet observed for this slip episode." : "Waiting for this packet."}</p>}
  </article>;
}

export const EscEventPanel = memo(function EscEventPanel({capture, connected, running, onAction}: Props) {
  const {detached} = useControlWindow();
  const panel = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const state = capture?.state ?? "idle";
  const event = capture?.event;
  const frozen = state === "frozen";
  const waiting = state === "armed" || state === "collecting";
  const disabled = !connected || !capture || busy;
  async function change(action: EscCaptureAction) {
    if (detached) panel.current?.scrollIntoView({block: "start"});
    setBusy(true);
    setError("");
    try { await onAction(action); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to change the event capture."); }
    finally { setBusy(false); }
  }
  const messages = {
    idle: "Arm the capture before wheel slip begins. The trigger is a front-left wheel at least 4 km/h faster than the rear left.",
    armed: running
      ? "Armed. Waiting for the wheel-speed gap to cross 4 km/h. Use Split grip in the moving model or watch an STM32 cycle."
      : "Armed. Start the simulation to observe the next wheel-slip event.",
    collecting: "Wheel slip detected. Collecting the response packets for this episode.",
    frozen: capture?.complete ? "Event frozen. The three packets are ready to inspect." :
      "Event frozen with missing packets. The worksheet includes the frames observed during this episode.",
  };
  return <section ref={panel} id="esc-event" className="esc-event" aria-label="Freeze ESC event" data-state={state}>
    <header className="esc-event-header">
      <div><h2>Freeze ESC event</h2>
        <p role="status">{messages[state]}</p>
      </div>
      <ControlSlot group="analysis">
        {detached && <div className="esc-remote-heading"><h2>Freeze ESC event</h2>
          <p role="status">{messages[state]}</p>
          {error && <p role="alert">{error}</p>}
        </div>}
        <div className="esc-event-controls">
          {frozen && event && <button type="button" className="esc-main-action"
            onClick={e => downloadCsv(`esc-event-${event.source}-${event.wheels.sequence}.csv`, escEventWorksheetCsv(event), e.currentTarget.ownerDocument)}>
            Download event worksheet (CSV)</button>}
          {!waiting && <button type="button" disabled={disabled} className={frozen ? undefined : "esc-main-action"}
            onClick={() => change("arm")}>{frozen ? "Arm for next slip" : "Arm for first slip"}</button>}
          {state !== "idle" && <button type="button" disabled={disabled}
            onClick={() => change("clear")}>{frozen ? "Return to live" : "Cancel capture"}</button>}
        </div>
      </ControlSlot>
    </header>
    {error && <p role="alert">{error}</p>}
    {event && <>
      <p className="esc-event-origin">{event.source === "firmware" ? "STM32 reference ECU" : "Dynamics model"}
        {" · "}Slip frame #{event.wheels.sequence}{" · "}
        <time dateTime={new Date(event.wheels.timestamp * 1000).toISOString()}>
          {new Date(event.wheels.timestamp * 1000).toISOString().slice(11, 23)} UTC
        </time></p>
      <div className="esc-event-cards">{streams.map(stream =>
        <PacketCard key={stream.key} stream={stream} event={event} frozen={frozen} />)}</div>
      <details className="esc-event-baseline"><summary>Wheel speeds before slip · Frame #{event.baseline.sequence}</summary>
        <Baseline event={event} /></details>
    </>}
  </section>;
});

function Baseline({event}: {event: EscEvent}) {
  const values = escPacketReadings(event.baseline, event);
  return <div><code>{spacedHex(event.baseline.data)}</code>
    <p>{escWheelFields.map(name => `${name} ${values[name + " (km/h)"]} km/h`).join(" · ")}</p>
    <p>{values["Offset from first slip (ms)"]} ms from slip</p>
  </div>;
}
