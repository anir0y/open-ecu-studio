// All inputs are classroom buttons. Each tab owns both cars and their CAN reports.
const exerciseActions = ["press", "save", "lock", "old_unlock", "handles", "close"] as const;
export type ExerciseAction = typeof exerciseActions[number];

// A virtual fob press is immutable so a later press cannot change the saved bytes.
export type FobPress = Readonly<{counter: number; data: string}>;

export type ExerciseCar = {
  locked: boolean;
  open: boolean;
  revision: number;
  body: string;
  bodySent: boolean;
  receipt: string | null;
  receiptInput: FobPress | null;
};

type ExerciseState = {
  vulnerable: ExerciseCar;
  protected: ExerciseCar;
  step: number;
  lastAction: ExerciseAction | "ready";
  lastPress: FobPress | null;
  savedPress: FobPress | null;
};

export type Exercise = ExerciseState & {history: readonly ExerciseState[]};

function hex(bytes: number[]): string {
  return bytes.map(byte => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function nextPress(previous: FobPress | null): FobPress {
  const counter = ((previous?.counter ?? 0) + 1) >>> 0;
  // ASCII U and a four-byte press number identify the input on the worksheet.
  return {counter, data: "55" + counter.toString(16).toUpperCase().padStart(8, "0")};
}

function bodyStatus(locked: boolean, open: boolean, revision: number, fromFob = false) {
  // Only the left handle is operated. The cabin lamp follows its door switch.
  return hex([0, 0, Number(open), Number(locked), 0, Number(open), Number(fromFob), revision]);
}

function initialState(): ExerciseState {
  const car: ExerciseCar = {
    locked: true, open: false, revision: 0,
    body: bodyStatus(true, false, 0), bodySent: false,
    receipt: null, receiptInput: null,
  };
  return { vulnerable: {...car}, protected: {...car}, step: 0, lastAction: "ready", lastPress: null, savedPress: null };
}

export function createExercise(): Exercise {
  return {...initialState(), history: []};
}

function updatedCar(car: ExerciseCar, locked: boolean, open: boolean, fromFob = false): ExerciseCar {
  const revision = (car.revision + 1) % 256;
  return {...car, locked, open, revision, bodySent: true, body: bodyStatus(locked, open, revision, fromFob)};
}

function cabinAction(car: ExerciseCar, action: "lock" | "handles" | "close"): ExerciseCar {
  switch (action) {
    case "lock":
      if (!car.open && !car.locked) return updatedCar(car, true, false);
      break;
    case "handles":
      if (!car.locked && !car.open) return updatedCar(car, false, true);
      break;
    case "close":
      if (car.open) return updatedCar(car, false, false);
      break;
  }
  return {...car, bodySent: false};
}

function fobResult(car: ExerciseCar, press: FobPress, accepted: boolean): ExerciseCar {
  const result = accepted ? updatedCar(car, false, car.open, true) : {...car, bodySent: false};
  // Echo the exact four counter bytes from this input in the synthetic CAN receipt.
  const receipt = hex([accepted ? 1 : 2, 0]) + press.data.slice(2) + hex([Number(result.locked), result.revision]);
  return {...result, receipt, receiptInput: press};
}

function advanceExercise(exercise: ExerciseState, action: ExerciseAction): ExerciseState {
  const next = {...exercise, step: exercise.step + 1, lastAction: action};
  switch (action) {
    case "press": {
      const press = nextPress(exercise.lastPress);
      return {...next, lastPress: press, vulnerable: fobResult(exercise.vulnerable, press, true),
        protected: fobResult(exercise.protected, press, true)};
    }
    case "save":
      if (!exercise.lastPress || exercise.lastPress === exercise.savedPress) return exercise;
      return {...next, savedPress: exercise.lastPress,
        vulnerable: {...exercise.vulnerable, bodySent: false}, protected: {...exercise.protected, bodySent: false}};
    case "old_unlock": {
      const saved = exercise.savedPress;
      if (!saved) return exercise;
      return {...next, vulnerable: fobResult(exercise.vulnerable, saved, true),
        protected: fobResult(exercise.protected, saved, false)};
    }
    default:
      return {...next, vulnerable: cabinAction(exercise.vulnerable, action), protected: cabinAction(exercise.protected, action)};
  }
}

export function applyExerciseAction(exercise: Exercise, action: ExerciseAction): Exercise {
  const {history, ...current} = exercise;
  const next = advanceExercise(current, action);
  if (next === current) return exercise;
  return {...next, history: [...history, next]};
}

export function serializeExercise(exercise: Exercise): string {
  return JSON.stringify({version: 1, actions: exercise.history.map(state => state.lastAction)});
}

export function restoreExercise(raw: string): Exercise {
  const stored: unknown = JSON.parse(raw);
  if (!stored || typeof stored !== "object" || !("version" in stored) || stored.version !== 1 ||
      !("actions" in stored) || !Array.isArray(stored.actions)) {
    throw new Error("Unrecognized receiver run format");
  }

  let current = initialState();
  const history: ExerciseState[] = [];
  for (const value of stored.actions) {
    const action = exerciseActions.find(name => name === value);
    if (action === undefined) throw new Error("Unknown action in saved receiver run");
    const next = advanceExercise(current, action);
    if (next === current) throw new Error("Action out of sequence in saved receiver run");
    history.push(next);
    current = next;
  }
  return {...current, history};
}
