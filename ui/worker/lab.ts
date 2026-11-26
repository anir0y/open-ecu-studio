export type FrameDirection = "bus" | "request" | "response";

export type Frame = {
  sequence: number;
  timestamp: number;
  id: string;
  arbitration_id: number;
  data: string;
  dlc: number;
  is_fd: boolean;
  is_extended_id: false;
  bitrate_switch: boolean;
  direction: FrameDirection;
};

type Inputs = {
  throttle_pct: number;
  brake_pct: number;
  steering_deg: number;
  road_grip: number;
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

type Body = {
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

const WHEEL_SPEED_ID = 0x181;
const DYNAMICS_ID = 0x182;
const VEHICLE_STATE_ID = 0x183;
const ESC_STATUS_ID = 0x280;
const BODY_STATUS_ID = 0x361;
const FOB_RECEIPT_ID = 0x362;
const FD_TELEMETRY_ID = 0x510;
const UDS_REQUEST_ID = 0x6a0;
const UDS_RESPONSE_ID = 0x6a8;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

function hex(bytes: number[]): string {
  return bytes.map(value => (value & 0xff).toString(16).padStart(2, "0")).join("").toUpperCase();
}

function u16(value: number): number[] {
  const integer = Math.round(value) & 0xffff;
  return [integer >>> 8, integer];
}

function i16(value: number): number[] {
  return u16(Math.round(value));
}

function u32(value: number): number[] {
  const integer = Math.round(value) >>> 0;
  return [integer >>> 24, integer >>> 16, integer >>> 8, integer];
}

function payloadBody(body: Body, fromFob: boolean): number[] {
  const doors = Number(body.left_open) | (Number(body.right_open) << 1);
  return [body.lights, body.signal, doors, Number(body.locked), Number(body.wiper), Number(Boolean(doors)), Number(fromFob), body.revision];
}

function payloadReceipt(body: Body): number[] {
  const decision = {accepted: 1, duplicate: 2, door_open: 3}[body.decision as "accepted" | "duplicate" | "door_open"] ?? 0;
  return [decision, Number(body.fob_lock), ...u32(body.fob_counter), Number(body.locked), body.revision];
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

export class LabSimulation {
  private running = false;
  private faultActive = false;
  private sequence = 0;
  private startedAt = Date.now();
  private lastTick = Date.now();
  private statusTick = 0;
  private frameTimes: number[] = [];
  private pending: Frame[] = [];
  private trace: Frame[] = [];
  private previousWheel?: Frame;
  private inputs: Inputs = {throttle_pct: 18, brake_pct: 0, steering_deg: 0, road_grip: 0.92};
  private wheels = [40, 40, 40, 40];
  private intervention = false;
  private sampleCounter = 0;
  private vehicle: Vehicle = {
    vehicle_speed_kph: 40,
    acceleration_mps2: 0,
    yaw_rate_dps: 0,
    steering_angle_deg: 0,
    brake_pressure_bar: 0,
    lateral_g: 0,
    heading_deg: 0,
    distance_m: 0,
    throttle_pct: 18,
    driver_brake_pct: 0,
    road_grip: 0.92,
  };
  private body: Body = {
    lights: 0,
    signal: 0,
    left_open: false,
    right_open: false,
    locked: false,
    wiper: false,
    revision: 0,
    fob_counter: 0,
    receiver_counter: 0,
    fob_lock: false,
    decision: "",
  };
  private bodyFrames: Record<string, Frame> = {};
  private capture: {state: string; event: Record<string, Frame | string | null> | null; complete: boolean} = {
    state: "idle",
    event: null,
    complete: false,
  };

  status(now = Date.now()) {
    this.frameTimes = this.frameTimes.filter(timestamp => timestamp >= now - 1000);
    return {
      interface: "cloudflare",
      channel: "private browser session",
      capabilities: {firmware: false},
      source: this.running ? "synthetic" : "idle",
      running: this.running,
      firmware_running: false,
      firmware_error: null,
      fault_active: this.faultActive,
      frame_count: this.sequence,
      frames_per_second: this.frameTimes.length,
      decoded: {
        wheel_speeds_kph: [...this.wheels],
        yaw_rate_dps: this.vehicle.yaw_rate_dps,
        steering_angle_deg: this.vehicle.steering_angle_deg,
        brake_pressure_bar: this.vehicle.brake_pressure_bar,
        intervention_active: this.intervention,
        sample_counter: this.sampleCounter,
        vehicle_speed_kph: this.vehicle.vehicle_speed_kph,
        acceleration_mps2: this.vehicle.acceleration_mps2,
        throttle_pct: this.vehicle.throttle_pct,
        driver_brake_pct: this.vehicle.driver_brake_pct,
        road_grip: this.vehicle.road_grip,
        lateral_g: this.vehicle.lateral_g,
      },
      vehicle: {...this.vehicle},
      vehicle_inputs: {...this.inputs},
      body: {...this.body},
      body_frames: copy(this.bodyFrames),
      esc_capture: copy(this.capture),
    };
  }

  start(source: string) {
    if (source !== "synthetic") throw new Error("STM32 firmware rehosting is available in the desktop and local apps.");
    this.running = true;
    this.startedAt = Date.now();
    this.lastTick = this.startedAt;
    return this.status();
  }

  stop() {
    this.running = false;
    return this.status();
  }

  setInputs(value: Partial<Inputs>) {
    this.inputs = {
      throttle_pct: clamp(Number(value.throttle_pct ?? this.inputs.throttle_pct), 0, 100),
      brake_pct: clamp(Number(value.brake_pct ?? this.inputs.brake_pct), 0, 100),
      steering_deg: clamp(Number(value.steering_deg ?? this.inputs.steering_deg), -30, 30),
      road_grip: clamp(Number(value.road_grip ?? this.inputs.road_grip), 0.2, 1),
    };
    return this.status();
  }

  setFault(active: boolean) {
    this.faultActive = Boolean(active);
    return this.status();
  }

  controlCapture(action: string) {
    if (action === "arm") this.capture = {state: "armed", event: null, complete: false};
    else if (action === "clear") this.capture = {state: "idle", event: null, complete: false};
    else throw new Error("Unknown ESC capture action.");
    return this.status();
  }

  bodyAction(action: string) {
    const changes: Record<string, Partial<Body>> = {
      lights_off: {lights: 0}, low_beam: {lights: 1}, high_beam: {lights: 2},
      signal_off: {signal: 0}, signal_left: {signal: 1}, signal_right: {signal: 2}, hazards: {signal: 3},
      wiper_off: {wiper: false}, wiper_on: {wiper: true}, open_left: {left_open: true},
      close_left: {left_open: false}, open_right: {right_open: true}, close_right: {right_open: false},
      lock: {locked: true}, unlock: {locked: false},
    };
    if (["fob_lock", "fob_unlock", "check_duplicate"].includes(action)) {
      const repeated = action === "check_duplicate";
      if (repeated && this.body.fob_counter === 0) throw new Error("Press a fob button before checking its duplicate.");
      const counter = repeated ? this.body.fob_counter : this.body.fob_counter + 1;
      const lock = repeated ? this.body.fob_lock : action === "fob_lock";
      const duplicate = counter <= this.body.receiver_counter;
      if (duplicate) this.body.decision = "duplicate";
      else {
        const doorOpen = lock && (this.body.left_open || this.body.right_open);
        this.body = {...this.body, fob_counter: counter, receiver_counter: counter, fob_lock: lock, decision: doorOpen ? "door_open" : "accepted"};
        if (!doorOpen) this.body = {...this.body, locked: lock, revision: (this.body.revision + 1) & 0xff};
      }
      if (duplicate) this.body = {...this.body, fob_counter: counter, fob_lock: lock};
      this.bodyFrames["0x362"] = this.emit(FOB_RECEIPT_ID, payloadReceipt(this.body));
      if (this.body.decision === "accepted") this.bodyFrames["0x361"] = this.emit(BODY_STATUS_ID, payloadBody(this.body, true));
      return this.status();
    }
    if (!(action in changes)) throw new Error("Unknown body action.");
    if ((action === "open_left" || action === "open_right") && this.body.locked) throw new Error("Unlock the doors before opening one.");
    if (action === "lock" && (this.body.left_open || this.body.right_open)) throw new Error("Close both doors before locking.");
    this.body = {...this.body, ...changes[action], revision: (this.body.revision + 1) & 0xff};
    this.bodyFrames["0x361"] = this.emit(BODY_STATUS_ID, payloadBody(this.body, false));
    return this.status();
  }

  diagnostic(service: string) {
    const definitions: Record<string, [number[], number[]]> = {
      extended_session: [[0x10, 0x03], [0x50, 0x03, 0x00, 0x32, 0x01, 0xf4]],
      tester_present: [[0x3e, 0x00], [0x7e, 0x00]],
      software_version: [[0x22, 0xf1, 0xa0], [0x62, 0xf1, 0xa0, 0x01, 0x00]],
      esc_state: [[0x22, 0xf1, 0xa1], [0x62, 0xf1, 0xa1, Number(this.intervention), 0x03]],
    };
    const definition = definitions[service];
    if (!definition) throw new Error("Unknown diagnostic service.");
    const [request, response] = definition;
    this.emit(UDS_REQUEST_ID, [request.length, ...request, ...Array(7 - request.length).fill(0)], false, "request");
    this.emit(UDS_RESPONSE_ID, [response.length, ...response, ...Array(7 - response.length).fill(0)], false, "response");
    return {request: hex(request), response: hex(response), positive: response[0] !== 0x7f};
  }

  tick(now = Date.now()): Frame[] {
    if (!this.running) return this.drainFrames();
    const dt = clamp((now - this.lastTick) / 1000, 0.02, 0.15);
    this.lastTick = now;
    this.drive(dt);
    const wheel = this.emit(WHEEL_SPEED_ID, this.wheels.flatMap(speed => u16(speed * 100)));
    const dynamics = this.emit(DYNAMICS_ID, [
      ...i16(this.vehicle.yaw_rate_dps * 100), ...i16(this.vehicle.steering_angle_deg * 10),
      ...u16(this.vehicle.brake_pressure_bar * 10), Number(this.intervention), this.sampleCounter,
    ]);
    this.emit(VEHICLE_STATE_ID, [
      ...u16(clamp(this.vehicle.vehicle_speed_kph, 0, 655.35) * 100), ...i16(clamp(this.vehicle.acceleration_mps2, -327.68, 327.67) * 100),
      Math.round(this.vehicle.throttle_pct), Math.round(this.vehicle.driver_brake_pct), Math.round(this.vehicle.road_grip * 100),
      Math.round(clamp(this.vehicle.lateral_g, -1.27, 1.27) * 100) & 0xff,
    ]);
    const esc = this.statusTick++ % 2 === 0
      ? this.emit(ESC_STATUS_ID, [1, 0, Number(this.intervention), this.sampleCounter, 0, 0, 0, 0])
      : undefined;
    this.emit(FD_TELEMETRY_ID, [
      ...u32(now - this.startedAt), ...this.wheels.flatMap(speed => u16(speed * 100)),
      ...i16(this.vehicle.yaw_rate_dps * 100), Number(this.intervention), this.sampleCounter,
    ], true);
    this.captureSlip(wheel, dynamics, esc ?? this.emit(ESC_STATUS_ID, [1, 0, 1, this.sampleCounter, 0, 0, 0, 0]));
    this.previousWheel = wheel;
    return this.drainFrames();
  }

  drainFrames(): Frame[] {
    const frames = this.pending;
    this.pending = [];
    return frames;
  }

  traceFrames(): Frame[] {
    return copy(this.trace);
  }

  private drive(dt: number) {
    const controls = this.inputs;
    this.vehicle.throttle_pct = controls.throttle_pct;
    this.vehicle.driver_brake_pct = controls.brake_pct;
    this.vehicle.road_grip = controls.road_grip;
    let speed = this.vehicle.vehicle_speed_kph / 3.6;
    const throttleAcceleration = controls.throttle_pct / 100 * 4.2 * controls.road_grip;
    const serviceBraking = controls.brake_pct / 100 * 9 * controls.road_grip;
    const drag = 0.10 + 0.004 * speed * speed;
    const acceleration = speed <= 0.02 && throttleAcceleration <= serviceBraking + drag ? 0 : throttleAcceleration - serviceBraking - drag;
    speed = clamp(speed + acceleration * dt, 0, 70);
    this.vehicle.vehicle_speed_kph = speed * 3.6;
    this.vehicle.acceleration_mps2 = acceleration;
    this.vehicle.steering_angle_deg += (controls.steering_deg - this.vehicle.steering_angle_deg) * Math.min(1, 8 * dt);
    const idealYaw = speed / 2.68 * Math.tan(this.vehicle.steering_angle_deg * Math.PI / 180);
    const gripYaw = clamp(idealYaw, -1.35 * controls.road_grip, 1.35 * controls.road_grip);
    const idealYawDps = gripYaw * 180 / Math.PI;
    this.vehicle.yaw_rate_dps += (idealYawDps - this.vehicle.yaw_rate_dps) * Math.min(1, 4.5 * controls.road_grip * dt);
    this.vehicle.heading_deg = (this.vehicle.heading_deg + this.vehicle.yaw_rate_dps * dt + 360) % 360;
    this.vehicle.lateral_g = speed * (this.vehicle.yaw_rate_dps * Math.PI / 180) / 9.81;
    this.vehicle.distance_m += speed * dt;
    const delta = this.vehicle.yaw_rate_dps * Math.PI / 180 * 1.58 * 1.8;
    const targets = [this.vehicle.vehicle_speed_kph - delta, this.vehicle.vehicle_speed_kph + delta, this.vehicle.vehicle_speed_kph - delta, this.vehicle.vehicle_speed_kph + delta].map(value => Math.max(0, value));
    if (this.faultActive) targets[2] *= 0.70;
    const response = Math.min(1, 12 * dt);
    this.wheels = this.wheels.map((speedValue, index) => speedValue + (targets[index] - speedValue) * response);
    const spread = Math.max(...this.wheels) - Math.min(...this.wheels);
    const yawError = Math.abs(idealYawDps - this.vehicle.yaw_rate_dps);
    this.intervention = spread >= 4 || yawError >= 12;
    const targetPressure = this.intervention ? Math.min(90, spread * 7 + yawError * 1.5) : 0;
    this.vehicle.brake_pressure_bar += (targetPressure - this.vehicle.brake_pressure_bar) * Math.min(1, (targetPressure ? 14 : 6) * dt);
    this.sampleCounter = (this.sampleCounter + 1) & 0xff;
  }

  private captureSlip(wheel: Frame, dynamics: Frame, esc: Frame) {
    if (this.capture.state !== "armed" || !this.previousWheel) return;
    const gap = this.wheels[0] - this.wheels[2];
    const previousBytes = this.previousWheel.data.match(/.{4}/g) ?? [];
    const previousGap = previousBytes.length >= 3 ? (parseInt(previousBytes[0], 16) - parseInt(previousBytes[2], 16)) / 100 : 0;
    if (gap < 4 || previousGap >= 4) return;
    this.capture = {
      state: "frozen",
      event: {source: "synthetic", baseline: this.previousWheel, wheels: wheel, dynamics, esc},
      complete: true,
    };
  }

  private emit(identifier: number, bytes: number[], isFd = false, direction: FrameDirection = "bus"): Frame {
    const frame: Frame = {
      sequence: ++this.sequence,
      timestamp: Date.now() / 1000,
      id: `0x${identifier.toString(16).toUpperCase()}`,
      arbitration_id: identifier,
      data: hex(bytes),
      dlc: bytes.length,
      is_fd: isFd,
      is_extended_id: false,
      bitrate_switch: isFd,
      direction,
    };
    this.pending.push(frame);
    this.trace.push(frame);
    this.frameTimes.push(Date.now());
    if (this.trace.length > 3000) this.trace.splice(0, this.trace.length - 3000);
    return frame;
  }
}
