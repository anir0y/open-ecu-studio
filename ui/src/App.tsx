import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import { activeMotionValue } from "./motion";
import { VehicleScene } from "./VehicleScene";
import { BodyControls, IndicatorSwitch, type BodyAction, type BodyState } from "./BodyControls";
import { ReceiverComparison } from "./ReceiverComparison";
import { PacketLesson } from "./PacketLesson";
import { DbcWorkspace } from "./DbcWorkspace";
import { AuthorView } from "./AuthorView";
import { EscEventPanel } from "./EscEventPanel";
import { ControlSlot, useControlWindow, type ControlGroup } from "./ControlWindow";
import type { EscCapture, EscCaptureAction } from "./packets";
import { loadDbcCatalog, type DbcMessage } from "./dbc";
import { examples, frameName, frameNames, spacedHex, type Packet } from "./packets";

type Source = "synthetic" | "firmware";

type Frame = {
  sequence: number;
  timestamp: number;
  id: string;
  arbitration_id: number;
  data: string;
  dlc: number;
  is_fd: boolean;
  is_extended_id: boolean;
  bitrate_switch: boolean;
  direction: "bus" | "request" | "response";
};

type Decoded = {
  wheel_speeds_kph: number[];
  yaw_rate_dps: number;
  steering_angle_deg: number;
  brake_pressure_bar: number;
  intervention_active: boolean;
  sample_counter: number;
  vehicle_speed_kph?: number;
  acceleration_mps2?: number;
  throttle_pct?: number;
  driver_brake_pct?: number;
  road_grip?: number;
  lateral_g?: number;
  firmware_version?: string;
};

type Vehicle = {
  vehicle_speed_kph: number;
  acceleration_mps2: number;
  yaw_rate_dps: number;
  steering_angle_deg: number;
  brake_pressure_bar: number;
  lateral_g: number;
  heading_deg: number;
  distance_m: number;
  throttle_pct: number;
  driver_brake_pct: number;
  road_grip: number;
};

type VehicleInputs = {
  throttle_pct: number;
  brake_pct: number;
  steering_deg: number;
  road_grip: number;
};

type Status = {
  interface: string;
  channel: string;
  capabilities?: { firmware: boolean };
  source: Source | "idle";
  running: boolean;
  firmware_running: boolean;
  firmware_error?: string | null;
  fault_active: boolean;
  frame_count: number;
  frames_per_second: number;
  decoded: Decoded;
  vehicle: Vehicle;
  vehicle_inputs: VehicleInputs;
  body?: BodyState;
  body_frames?: Record<string, Frame>;
  esc_capture?: EscCapture;
};

type WsPayload = { frames: Frame[]; status: Status };

type AuthInfo = {
  authenticated: boolean;
  email?: string;
  logout_url: string;
};

const workspaceLinks = [
  ["drive-lab", "Drive lab"], ["esc-event", "Freeze ESC event"], ["body-controls", "Body controls"],
  ["signals", "Signals"], ["diagnostics", "Diagnostics"], ["dbc-workspace", "DBC workbench"], ["packet-lesson", "Packet classroom"], ["author", "Author"],
] as const;

const initialInputs: VehicleInputs = {
  throttle_pct: 18,
  brake_pct: 0,
  steering_deg: 0,
  road_grip: 0.92,
};

const emptyVehicle: Vehicle = {
  vehicle_speed_kph: 0,
  acceleration_mps2: 0,
  yaw_rate_dps: 0,
  steering_angle_deg: 0,
  brake_pressure_bar: 0,
  lateral_g: 0,
  heading_deg: 0,
  distance_m: 0,
  throttle_pct: 0,
  driver_brake_pct: 0,
  road_grip: 0.92,
};

const emptyStatus: Status = {
  interface: "—",
  channel: "—",
  source: "idle",
  running: false,
  firmware_running: false,
  fault_active: false,
  frame_count: 0,
  frames_per_second: 0,
  decoded: {
    wheel_speeds_kph: [0, 0, 0, 0],
    yaw_rate_dps: 0,
    steering_angle_deg: 0,
    brake_pressure_bar: 0,
    intervention_active: false,
    sample_counter: 0,
  },
  vehicle: emptyVehicle,
  vehicle_inputs: initialInputs,
};

const diagnostics = [
  ["extended_session", "Extended session", "10 03"],
  ["tester_present", "Tester present", "3E 00"],
  ["software_version", "Software version", "22 F1 A0"],
  ["esc_state", "ESC state", "22 F1 A1"],
] as const;

const browserSession = (() => {
  const key = "open-ecu-cloud-session-v1";
  const saved = localStorage.getItem(key);
  if (saved) return saved;
  const created = crypto.randomUUID();
  localStorage.setItem(key, created);
  return created;
})();

async function api<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: {
      "X-ECU-Session": browserSession,
      ...(body ? {"Content-Type": "application/json"} : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.detail ?? `Request failed (${response.status})`);
  return payload as T;
}

function RangeControl({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit: string;
  onChange: (value: number) => void;
}) {
  const progress = ((value - min) / (max - min)) * 100;
  return (
    <label className="range-control">
      <span>{label}<strong>{value.toFixed(step < 1 ? 2 : 0)} {unit}</strong></span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ "--range-progress": `${progress}%` } as React.CSSProperties}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function SignalTimeline({ frames, customMessages }: { frames: Frame[]; customMessages: DbcMessage[] }) {
  const display = frames.slice(-54);
  return (
    <div className="signal-track" aria-label="Live CAN traffic">
      <div className="signal-axis"><span>3 seconds ago</span><span>now</span></div>
      <div className="signal-line">
        {display.map((frame, index) => (
          <i
            key={frame.sequence}
            className={`${frame.direction} ${frame.is_fd ? "fd" : ""}`}
            style={{ left: `${(index / Math.max(1, display.length - 1)) * 100}%` }}
            title={`${frame.id} ${frameName(frame.id, customMessages)} ${frame.data}`}
          />
        ))}
      </div>
      <div className="signal-key"><span className="telemetry">Telemetry</span><span className="diagnostic">Diagnostic</span><span className="fd-key">CAN-FD</span></div>
    </div>
  );
}

function Metric({ label, value, unit, alert = false }: { label: string; value: string; unit: string; alert?: boolean }) {
  return <div className={`live-metric ${alert ? "alert" : ""}`}><span>{label}</span><strong>{value}</strong><small>{unit}</small></div>;
}

export default function App() {
  const controls = useControlWindow();
  const [section, setSection] = useState(() => location.hash.slice(1) || "drive-lab");
  const lastLabSection = useRef("drive-lab");
  const showingAuthor = section === "author";
  useEffect(() => {
    const navigate = () => setSection(location.hash.slice(1) || "drive-lab");
    window.addEventListener("hashchange", navigate);
    return () => window.removeEventListener("hashchange", navigate);
  }, []);
  useEffect(() => {
    if (!showingAuthor) lastLabSection.current = section;
    if (location.hash) document.getElementById(section)?.scrollIntoView({block: "start"});
  }, [section, showingAuthor]);
  const [status, setStatus] = useState<Status>(emptyStatus);
  const [source, setSource] = useState<Source>("synthetic");
  const [inputs, setInputs] = useState<VehicleInputs>(initialInputs);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [lesson, setLesson] = useState<Packet>(examples[0]);
  const [dbcCatalog, setDbcCatalog] = useState(loadDbcCatalog);
  const pendingInputs = useRef(false);
  const changeInputs: typeof setInputs = (value) => {
    pendingInputs.current = true;
    setInputs(value);
  };
  const [connected, setConnected] = useState(false);
  const [auth, setAuth] = useState<AuthInfo>();
  const [busy, setBusy] = useState(false);
  const [signalPending, setSignalPending] = useState(false);
  const [error, setError] = useState("");
  const [diagnosticResult, setDiagnosticResult] = useState("Ready for a read-only request");
  const reconnectTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let active = true;
    let socket: WebSocket | undefined;
    let cloudTimer: number | undefined;
    let cloudPending = false;
    const applyPayload = (payload: WsPayload, firstStatus = false) => {
      if (!active) return;
      if (firstStatus && payload.status.running) {
        setSource(payload.status.source === "firmware" ? "firmware" : "synthetic");
        if (!pendingInputs.current) setInputs(payload.status.vehicle_inputs);
      }
      setStatus(payload.status);
      if (payload.frames.length) setFrames((current) => [...current, ...payload.frames].slice(-360));
    };
    const connect = () => {
      let firstStatus = true;
      const protocol = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${protocol}://${location.host}/ws?session=${encodeURIComponent(browserSession)}`);
      socket.onopen = () => active && setConnected(true);
      socket.onmessage = (event) => {
        const payload = JSON.parse(event.data) as WsPayload;
        applyPayload(payload, firstStatus);
        firstStatus = false;
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (!active) return;
        setConnected(false);
        reconnectTimer.current = window.setTimeout(connect, 1000);
      };
    };
    api<Status>("/api/status").then(initial => {
      applyPayload({frames: [], status: initial}, true);
      if (initial.interface !== "cloudflare") {
        connect();
        return;
      }
      api<AuthInfo>("/api/auth").then(setAuth).catch(() => undefined);
      setConnected(true);
      cloudTimer = window.setInterval(async () => {
        if (cloudPending) return;
        cloudPending = true;
        try { applyPayload(await api<WsPayload>("/api/tick")); }
        catch (cause) {
          setConnected(false);
          setError(cause instanceof Error ? cause.message : "Cloud classroom disconnected");
        } finally { cloudPending = false; }
      }, 100);
    }).catch((cause: Error) => setError(cause.message));
    return () => {
      active = false;
      window.clearTimeout(reconnectTimer.current);
      window.clearInterval(cloudTimer);
      socket?.close();
    };
  }, []);

  useEffect(() => {
    if (!pendingInputs.current || !status.running || status.source !== "synthetic") return;
    const timer = window.setTimeout(() => {
      pendingInputs.current = false;
      api<Status>("/api/vehicle", inputs).catch((cause: Error) => setError(cause.message));
    }, 70);
    return () => window.clearTimeout(timer);
  }, [inputs, status.source, status.running]);

  useEffect(() => {
    if (source !== "synthetic" || showingAuthor) return;
    const held = new Set<string>();
    const setKey = (key: string, pressed: boolean) => {
      changeInputs((current) => ({
        ...current,
        throttle_pct: key === "w" ? (pressed ? 72 : 18) : current.throttle_pct,
        brake_pct: key === "s" ? (pressed ? 82 : 0) : current.brake_pct,
        steering_deg: key === "a" ? (pressed ? -22 : 0) : key === "d" ? (pressed ? 22 : 0) : current.steering_deg,
      }));
    };
    const down = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (!["w", "a", "s", "d"].includes(key) || event.metaKey || event.ctrlKey || event.altKey) return;
      if ((event.target as Element | null)?.closest?.("input, select, textarea, [contenteditable=true]")) return;
      event.preventDefault();
      if (held.has(key)) return;
      held.add(key);
      setKey(key, true);
    };
    const up = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (held.delete(key)) setKey(key, false);
    };
    const release = () => {
      for (const key of held) setKey(key, false);
      held.clear();
    };
    const windows = controls.popup ? [window, controls.popup] : [window];
    for (const target of windows) {
      target.addEventListener("keydown", down);
      target.addEventListener("keyup", up);
      target.addEventListener("blur", release);
    }
    return () => {
      release();
      for (const target of windows) {
        if (target.closed) continue;
        target.removeEventListener("keydown", down);
        target.removeEventListener("keyup", up);
        target.removeEventListener("blur", release);
      }
    };
  }, [source, showingAuthor, controls.popup]);

  const runAction = async () => {
    setBusy(true);
    setError("");
    try {
      if (!status.running && source === "synthetic") {
        await api("/api/vehicle", inputs);
        pendingInputs.current = false;
      }
      const next = status.running
        ? await api<Status>("/api/stop", {})
        : await api<Status>("/api/run", { source });
      setStatus(next);
      setDiagnosticResult(next.running ? "Ready for a read-only request" : "Run stopped · trace retained");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to change run state");
    } finally {
      setBusy(false);
    }
  };

  const setFault = async (active: boolean) => {
    setBusy(true);
    try {
      setStatus(await api<Status>("/api/fault", { active }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to change scenario");
    } finally {
      setBusy(false);
    }
  };

  const applyPreset = (preset: "cruise" | "slalom" | "brake" | "split") => {
    const next = {
      cruise: { throttle_pct: 28, brake_pct: 0, steering_deg: 0, road_grip: 0.92 },
      slalom: { throttle_pct: 24, brake_pct: 0, steering_deg: 18, road_grip: 0.88 },
      brake: { throttle_pct: 0, brake_pct: 88, steering_deg: 0, road_grip: 0.92 },
      split: { throttle_pct: 20, brake_pct: 15, steering_deg: 0, road_grip: 0.55 },
    }[preset];
    changeInputs(next);
    void setFault(preset === "split");
  };

  const runDiagnostic = async (service: string, label: string) => {
    setBusy(true);
    setDiagnosticResult(`${label} in progress…`);
    try {
      const result = await api<{ request: string; response: string; positive: boolean }>("/api/diagnostics", { service });
      setDiagnosticResult(`TX ${result.request}  /  RX ${result.response}  /  ${result.positive ? "positive" : "negative"}`);
    } catch (cause) {
      setDiagnosticResult(cause instanceof Error ? cause.message : "No diagnostic response");
    } finally {
      setBusy(false);
    }
  };

  const decodedVehicle = status.vehicle ?? emptyVehicle;
  const firmwareMode = (status.running ? status.source : source) === "firmware";
  const reportedSpeed = firmwareMode ? status.decoded.wheel_speeds_kph[0] :
    status.decoded.vehicle_speed_kph ?? decodedVehicle.vehicle_speed_kph;
  const liveAcceleration = activeMotionValue(
    status.running,
    firmwareMode ? 0 : status.decoded.acceleration_mps2 ?? decodedVehicle.acceleration_mps2,
  );
  const liveYawRate = activeMotionValue(status.running, status.decoded.yaw_rate_dps);
  const liveLateralLoad = activeMotionValue(
    status.running,
    status.decoded.lateral_g ?? decodedVehicle.lateral_g,
  );
  const liveBrakePressure = activeMotionValue(status.running, status.decoded.brake_pressure_bar);
  const liveBusRate = activeMotionValue(status.running, status.frames_per_second);
  const visualState = {
    speedKph: activeMotionValue(status.running, reportedSpeed),
    acceleration: liveAcceleration,
    steeringDeg: status.running ? status.decoded.steering_angle_deg : source === "synthetic" ? inputs.steering_deg : 0,
    yawRate: liveYawRate,
    wheelSpeeds: status.decoded.wheel_speeds_kph.map((speed) => activeMotionValue(status.running, speed)),
    intervention: status.running && status.decoded.intervention_active,
    faultActive: status.running && (firmwareMode ? status.decoded.intervention_active : status.fault_active),
  };
  const recentFrames = useMemo(() => [...frames].reverse().slice(0, 14), [frames]);
  const firmwareAvailable = status.capabilities?.firmware ?? true;
  const bodyAvailable = source === "synthetic" && status.source !== "firmware" && ["virtual", "cloudflare"].includes(status.interface);
  const latestPacket = status.body_frames?.[lesson.id] ?? frames[frames.map(frame => frame.id).lastIndexOf(lesson.id)];
  const runBodyAction = async (action: BodyAction) => {
    const result = await api<Status>("/api/body", {action});
    setStatus(result);
  };
  const selectSceneSignal = async (action: BodyAction) => {
    setSignalPending(true);
    try {
      await runBodyAction(action);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to change the indicators");
    } finally {
      setSignalPending(false);
    }
  };
  const desktopVersion = window.openEcuDesktop?.version;
  async function changeEscCapture(action: EscCaptureAction) {
    setStatus(await api<Status>("/api/esc-capture", {action}));
  }
  function openControlSection(event: MouseEvent<HTMLAnchorElement>, group: ControlGroup) {
    if (!controls.detached) return;
    event.preventDefault();
    controls.focus(group);
    if (event.currentTarget.hash === "#diagnostics") location.hash = "diagnostics";
  }

  return (
    <div className={`studio-shell${controls.detached ? " controls-detached" : ""}`}>
      <header className="studio-header" data-platform={window.openEcuDesktop?.platform}>
        <div className="window-drag-region" />
        <div className="studio-identity"><div className="studio-glyph"><i /><i /><i /></div><span><strong>Open ECU Studio</strong><small>Vehicle dynamics and network laboratory</small></span></div>
        <nav aria-label="Workspace">{workspaceLinks.map(([id, label]) => <a key={id} href={`#${id}`}
          className={section === id ? "active" : undefined} aria-current={section === id ? "location" : undefined}>{label}</a>)}</nav>
        <div className="studio-tools">
          <div className="link-state"><i className={connected ? "connected" : ""} /><span>{connected ? "Lab connected" : "Reconnecting"}</span>{desktopVersion && <small>Desktop {desktopVersion}</small>}</div>
          {auth?.authenticated && <div className="account-state"><span title={auth.email}>{auth.email}</span><a href={auth.logout_url}>Sign out</a></div>}
          {controls.detached ? <div className="window-actions">
            <button onClick={() => controls.focus()}>Show controls</button>
            <button onClick={controls.dock}>Dock controls</button>
          </div> : <button id="detach-controls" className="detach-button" onClick={controls.detach}>Detach controls</button>}
        </div>
      </header>

      {error && <div className="studio-notice" role="alert"><strong>Run notice</strong><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss notice">Close</button></div>}
      {controls.error && <div className="studio-notice" role="alert">{controls.error}</div>}
      {!error && status.firmware_error && <div className="studio-notice" role="alert"><strong>Firmware stopped</strong><span>{status.firmware_error}</span></div>}

      {showingAuthor && <AuthorView returnTo={`#${lastLabSection.current}`} />}
      <main hidden={showingAuthor} aria-label="Lab">
        <section className="drive-bay" id="drive-lab">
          <div className="model-stage">
            <VehicleScene state={visualState} body={bodyAvailable ? status.body : undefined} />
            {!controls.detached && bodyAvailable && status.body && <fieldset className="scene-indicators" disabled={!connected || signalPending}>
              <IndicatorSwitch name="Turn signals" signal={status.body.signal} onSelect={selectSceneSignal} />
            </fieldset>}
            <div className="stage-title"><span>{firmwareMode ? "STM32F407 reference ECU" : "Interactive vehicle"}</span><strong>{status.running ? (firmwareMode ? "Firmware telemetry" : "Dynamics live") : "Ready on rolling road"}</strong></div>
            <div className="speed-readout"><strong>{visualState.speedKph.toFixed(1)}</strong><span>{firmwareMode ? "km/h · front left" : "km/h"}</span></div>
            <div className="stage-hint">Drag to orbit · scroll to zoom</div>
            <a className="model-credit" href="https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CarConcept" target="_blank" rel="noreferrer">Car Concept · Eric Chadwick · CC BY 4.0</a>
            <div className={`esc-beacon ${visualState.intervention ? "active" : ""}`}><i /><span>ESC<br/><strong>{visualState.intervention ? "Intervening" : "Monitoring"}</strong></span></div>
          </div>

          <ControlSlot group="drive"><aside className="drive-deck">
            <div className="deck-heading"><span>{firmwareMode ? "Firmware station" : "Driver station"}</span><strong>{firmwareMode ? "Observe the reference ECU" : "Control the model"}</strong></div>
            <div className="source-picker" role="group" aria-label="Execution source">
              <button className={!firmwareMode ? "selected" : ""} aria-pressed={!firmwareMode} onClick={() => setSource("synthetic")} disabled={status.running || busy}><strong>Dynamics model</strong><small>Live controls and CAN-FD</small></button>
              <button className={firmwareMode ? "selected" : ""} aria-pressed={firmwareMode} onClick={() => setSource("firmware")} disabled={status.running || busy || !firmwareAvailable}><strong>STM32 reference ECU</strong><small>{!firmwareAvailable ? "Desktop and local app only" : status.interface === "socketcan" ? "Renode · Linux vcan" : "Cortex-M4 · virtual CAN"}</small></button>
            </div>
            <button className={`primary-run ${status.running ? "stop" : ""}`} onClick={runAction} disabled={busy}><i />{status.running ? "Stop simulation" : "Start simulation"}</button>

            {firmwareMode ? <div className="firmware-observation">
              <h3>Watch one ESC cycle</h3>
              <p>The firmware repeats a wheel-slip scenario. Watch the rear-left wheel drop from 40 to 30 km/h and brake pressure rise to 60 bar.</p>
              <a href="#esc-event" onClick={(event) => openControlSection(event, "analysis")}>Freeze the first wheel-slip event ↓</a>
              <a href="#diagnostics" onClick={(event) => openControlSection(event, "analysis")}>Read the firmware version ↓</a>
            </div> : <><div className="control-stack">
              <RangeControl label="Throttle" value={inputs.throttle_pct} min={0} max={100} unit="%" onChange={(value) => changeInputs({ ...inputs, throttle_pct: value })} />
              <RangeControl label="Brake" value={inputs.brake_pct} min={0} max={100} unit="%" onChange={(value) => changeInputs({ ...inputs, brake_pct: value })} />
              <RangeControl label="Steering command" value={inputs.steering_deg} min={-30} max={30} unit="°" onChange={(value) => changeInputs({ ...inputs, steering_deg: value })} />
              <div className="steer-feedback"><span>{status.running ? "Measured" : "Preview"} <strong>{visualState.steeringDeg.toFixed(1)}°</strong></span>
                <button disabled={source === "firmware"} onClick={() => changeInputs(current => ({ ...current, steering_deg: 0 }))}>Center steering</button></div>
              <RangeControl label="Road grip" value={inputs.road_grip} min={0.2} max={1} step={0.01} unit="μ" onChange={(value) => changeInputs({ ...inputs, road_grip: value })} />
            </div>

            <div className="preset-grid">
              <button onClick={() => applyPreset("cruise")}>Cruise</button><button onClick={() => applyPreset("slalom")}>Slalom</button><button onClick={() => applyPreset("brake")}>Hard brake</button><button className={status.fault_active ? "active" : ""} onClick={() => applyPreset("split")}>Split grip</button>
            </div>
            <div className="keyboard-guide"><span><kbd>W</kbd> throttle</span><span><kbd>S</kbd> brake</span><span><kbd>A</kbd><kbd>D</kbd> steer</span></div>
            <a className="cabin-shortcut" href="#body-controls" onClick={(event) => openControlSection(event, "body")}>Lights, doors and key fob ↓</a></>}
          </aside></ControlSlot>
        </section>

        <section className="metric-ribbon" aria-label="Vehicle telemetry">
          <Metric label={firmwareMode ? "Front-left wheel" : "Vehicle speed"} value={visualState.speedKph.toFixed(1)} unit="km/h" />
          {firmwareMode ? <Metric label="Rear-left wheel" value={visualState.wheelSpeeds[2].toFixed(1)} unit="km/h" /> :
            <Metric label="Acceleration" value={liveAcceleration.toFixed(2)} unit="m/s²" />}
          <Metric label="Yaw rate" value={liveYawRate.toFixed(2)} unit="deg/s" />
          {firmwareMode ? <Metric label="Steering angle" value={visualState.steeringDeg.toFixed(1)} unit="°" /> :
            <Metric label="Lateral load" value={liveLateralLoad.toFixed(2)} unit="g" />}
          <Metric label="Brake pressure" value={liveBrakePressure.toFixed(1)} unit="bar" alert={visualState.intervention} />
          <Metric label="Bus rate" value={String(liveBusRate)} unit="frames/s" />
        </section>

        <EscEventPanel capture={status.esc_capture} connected={connected} running={status.running} onAction={changeEscCapture} />
        <BodyControls body={bodyAvailable ? status.body : undefined} frames={status.body_frames ?? {}}
          disabled={!connected || !bodyAvailable || !status.body}
          onAction={runBodyAction} onInspect={setLesson} />
        <ReceiverComparison />

        <section className="signals-workspace" id="signals">
          <div className="signals-main">
            <div className="section-heading"><span><strong>Signal rail</strong><small>{status.frame_count.toLocaleString()} frames observed</small></span><div className="source-address">{status.interface} / {status.channel}</div></div>
            <SignalTimeline frames={frames} customMessages={dbcCatalog?.messages ?? []} />
            <div className="wheel-strip">
              {visualState.wheelSpeeds.map((speed, index) => <div key={index} className={index === 2 && visualState.faultActive ? "fault" : ""}><span>{["Front left", "Front right", "Rear left", "Rear right"][index]}</span><strong>{speed.toFixed(2)}</strong><small>km/h</small></div>)}
            </div>
          </div>

          <aside className="diagnostic-deck" id="diagnostics">
            <div className="section-heading"><span><strong>Read-only diagnostics</strong><small>Safe ISO-TP single frames</small></span></div>
            <ControlSlot group="analysis"><div className="diagnostic-actions">
              {controls.detached && <h3>Read-only diagnostics</h3>}
              {diagnostics.map(([service, label, code]) => <button key={service} onClick={() => runDiagnostic(service, label)} disabled={busy || !status.running}><span>{label}</span><code>{code}</code></button>)}
              {controls.detached && <output>{diagnosticResult}</output>}
            </div></ControlSlot>
            <output>{diagnosticResult}</output>
          </aside>
        </section>

        <DbcWorkspace catalog={dbcCatalog} onCatalogChange={setDbcCatalog} onInspect={setLesson} />
        <PacketLesson packet={lesson} latest={latestPacket} customMessages={dbcCatalog?.messages} onSelect={setLesson} />
        <section className="frame-workspace">
          <div className="section-heading"><span><strong>Network analyzer</strong><small>Newest frames first</small></span><ControlSlot group="analysis"><a className="export-trace" href={`${location.origin}/api/trace`} download="open-ecu-trace.json">Export JSON trace</a></ControlSlot></div>
          <div className="frame-table" role="table" aria-label="Recent CAN frames">
            <div className="frame-row frame-header" role="row"><span>Identifier</span><span>Signal</span><span>Payload</span><span>Format</span></div>
            {recentFrames.length === 0 ? <div className="empty-log">Start the simulation to populate the analyzer.</div> : recentFrames.map(frame =>
              <div className={`frame-row ${frame.direction}`} role="row" key={frame.sequence}>
                <a href="#packet-lesson" aria-label={`Inspect frame ${frame.sequence}, ${frame.id}`} onClick={() => setLesson(frame)}>{frame.id}</a>
                <span>{frameName(frame.id, dbcCatalog?.messages)}</span><code>{spacedHex(frame.data)}</code>
                <small>{frame.is_fd ? "CAN-FD" : frame.direction === "bus" ? "CAN 2.0" : "ISO-TP"}</small>
              </div>)}
          </div>
        </section>
      </main>

      <footer className="studio-footer"><span>Software-only network · invented identifiers · no physical vehicle connection</span><span>{[...Object.keys(frameNames), ...(dbcCatalog?.messages.map(message => message.idHex) ?? [])].sort().join(" / ")}</span></footer>
    </div>
  );
}
