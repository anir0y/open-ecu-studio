import { useState } from "react";
import { ControlSlot, useControlWindow } from "./ControlWindow";
import { spacedHex, type Packet } from "./packets";
import "./body-controls.css";

export type BodyState = {
  lights: number;
  signal: number;
  left_open: boolean;
  right_open: boolean;
  locked: boolean;
  wiper: boolean;
  revision: number;
  fob_counter: number;
  receiver_counter: number;
  fob_lock: boolean;
  decision: string;
};

export type BodyAction =
  | "lights_off" | "low_beam" | "high_beam"
  | "signal_off" | "signal_left" | "signal_right" | "hazards"
  | "wiper_off" | "wiper_on"
  | "open_left" | "close_left" | "open_right" | "close_right"
  | "lock" | "unlock" | "fob_lock" | "fob_unlock" | "check_duplicate";

type Props = {
  body: BodyState | undefined;
  frames: Record<string, Packet>;
  disabled: boolean;
  onAction: (action: BodyAction) => Promise<void>;
  onInspect: (packet: Packet) => void;
};

type Choice = readonly [label: string, action: BodyAction, unavailable?: boolean];

function SwitchGroup({ name, address, choices, selected, onSelect }: {
  name: string;
  address: string;
  choices: readonly Choice[];
  selected: number | undefined;
  onSelect: (action: BodyAction) => void;
}) {
  return <div className="body-switch" role="group" aria-label={name}>
    <div className="body-switch-label"><strong>{name}</strong><code>{address}</code></div>
    <div className="body-options">
      {choices.map(([label, action, unavailable], index) =>
        <button type="button" key={action} aria-pressed={selected === index}
          onClick={() => onSelect(action)} disabled={unavailable}>{label}</button>
      )}
    </div>
  </div>;
}

function LatestPacket({ id, label, packet, onInspect }: {
  id: string;
  label: string;
  packet: Packet | undefined;
  onInspect: (packet: Packet) => void;
}) {
  return <div className="body-packet">
    <div><code>{id}</code> {label}</div>
    {packet ? <a href="#packet-lesson" onClick={() => onInspect(packet)}
      aria-label={`Inspect ${label.toLowerCase()} in packet classroom`}>
      <code>{spacedHex(packet.data)}</code><span>Inspect ↗</span>
    </a> : <span className="body-muted">Awaiting first frame</span>}
  </div>;
}

export function IndicatorSwitch({name, signal, onSelect}: {
  name: string;
  signal?: number;
  onSelect: (action: BodyAction) => void;
}) {
  return <SwitchGroup name={name} address="B1" selected={signal} onSelect={onSelect}
    choices={[["Off","signal_off"],["Left","signal_left"],["Right","signal_right"],["Hazards","hazards"]]} />;
}

const decisionLabels: Record<string, string> = {
  accepted: "Accepted",
  duplicate: "Rejected · counter already used",
  door_open: "Rejected · door open",
};

export function BodyControls({ body, frames, disabled, onAction, onInspect }: Props) {
  const {detached, focus} = useControlWindow();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function send(action: BodyAction) {
    if (busy || disabled || !body) return;
    setBusy(true);
    setError("");
    try {
      await onAction(action);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The control could not be applied.");
    } finally {
      setBusy(false);
    }
  }
  const doorOpen = body?.left_open || body?.right_open;
  const unavailable = disabled || !body;
  return <section id="body-controls" className="body-console" aria-labelledby="body-heading">
    <header className="body-heading">
      <h2 id="body-heading">Body controls</h2>
      <p>{detached ? "Use the Body tab in the controls window to change these signals." : "Use these switches while parked or driving. Inspect the resulting CAN frame below."}</p>
    </header>
    <ControlSlot group="body">
      {unavailable && <p className="body-notice" role="status">Body controls require a connected dynamics model on the virtual bus.</p>}
      {error && <p className="body-notice body-error" role="alert">{error}</p>}
      <div className="body-columns">
        <fieldset disabled={unavailable || busy} className="body-module">
          <legend>Lights &amp; visibility</legend>
          <SwitchGroup name="Headlights" address="B0" selected={body?.lights} onSelect={send}
            choices={[["Off","lights_off"],["Low beam","low_beam"],["High beam","high_beam"]]} />
          <IndicatorSwitch name="Indicators" signal={body?.signal} onSelect={send} />
          <SwitchGroup name="Wipers" address="B4" selected={body && Number(body.wiper)} onSelect={send}
            choices={[["Parked","wiper_off"],["Sweeping","wiper_on"]]} />
        </fieldset>
        <fieldset disabled={unavailable || busy} className="body-module">
          <legend>Doors &amp; cabin</legend>
          <SwitchGroup name="Left door" address="B2 · bit 0" selected={body && Number(body.left_open)} onSelect={send}
            choices={[["Closed","close_left"],["Open","open_left",body?.locked]]} />
          <SwitchGroup name="Right door" address="B2 · bit 1" selected={body && Number(body.right_open)} onSelect={send}
            choices={[["Closed","close_right"],["Open","open_right",body?.locked]]} />
          <SwitchGroup name="Central lock" address="B3" selected={body && Number(body.locked)} onSelect={send}
            choices={[["Unlocked","unlock"],["Locked","lock",doorOpen]]} />
          <div className="body-cabin"><span>Cabin light <code>B5</code></span>
            <strong>{body ? doorOpen ? "On" : "Off" : "—"}</strong></div>
          <small className="body-muted">{doorOpen ? "Close both doors to lock." : body?.locked ? "Unlock to open either door." : "Opening either door turns on the cabin light."}</small>
        </fieldset>
        <fieldset disabled={unavailable || busy} className="body-module body-fob">
          <legend>Key fob receiver</legend>
          <p>Each simulated press gets a counter. The receiver sends its decision on CAN and updates the lock for an accepted press.</p>
          <div className="body-options">
            <button type="button" onClick={() => send("fob_lock")}>Fob lock</button>
            <button type="button" onClick={() => send("fob_unlock")}>Fob unlock</button>
          </div>
          <button type="button" className="body-duplicate" disabled={!body?.fob_counter} onClick={() => send("check_duplicate")}>Check duplicate</button>
          <dl className="body-decision" aria-live="polite">
            <div><dt>Last fob press</dt><dd>{body?.fob_counter ? `${body.fob_lock ? "Lock" : "Unlock"} · #${body.fob_counter}` : "—"}</dd></div>
            <div><dt>Receiver</dt><dd>{decisionLabels[body?.decision ?? ""] ?? "Waiting for a press"}</dd></div>
          </dl>
          {detached
            ? <button type="button" className="body-comparison-link" onClick={() => focus("receiver")}>Compare both receivers →</button>
            : <a className="body-comparison-link" href="#receiver-comparison">Compare both receivers and their packets ↓</a>}
        </fieldset>
      </div>
    </ControlSlot>
    <div className="body-packets">
      <LatestPacket id="0x361" label="Latest body status" packet={frames["0x361"]} onInspect={onInspect} />
      <LatestPacket id="0x362" label="Latest receiver decision" packet={frames["0x362"]} onInspect={onInspect} />
    </div>
  </section>;
}
