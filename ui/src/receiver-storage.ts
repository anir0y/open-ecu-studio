import { createExercise, restoreExercise, serializeExercise, type Exercise } from "./receiver-exercise";

const key = "open-ecu.receiver-run";
type StorageArea = "sessionStorage" | "localStorage";

function read(area: StorageArea): string | null | undefined {
  try {
    if (area === "localStorage" && window.openEcuDesktop?.receiverRun) {
      const value = window.openEcuDesktop.receiverRun.read();
      return value === false ? undefined : value;
    }
    return window[area].getItem(key);
  }
  catch { return undefined; }
}

function write(area: StorageArea, value: string | null): boolean {
  try {
    if (area === "localStorage" && window.openEcuDesktop?.receiverRun) return window.openEcuDesktop.receiverRun.write(value);
    if (value === null) window[area].removeItem(key);
    else window[area].setItem(key, value);
    return true;
  } catch { return false; }
}

type BrowserRun = {
  exercise: Exercise;
  lastBrowserCopy: string | null;
  notice: string;
  initialTabCopy?: string;
};

export function loadBrowserRun(): BrowserRun {
  let unreadable = false;
  for (const area of ["sessionStorage", "localStorage"] as const) {
    const raw = read(area);
    if (raw == null) continue;
    try {
      const exercise = restoreExercise(raw);
      return {exercise, lastBrowserCopy: raw, initialTabCopy: raw,
        notice: exercise.step ? (window.openEcuDesktop?.receiverRun ? "Desktop run restored." : "Run restored in this browser.") : ""};
    } catch { unreadable = true; }
  }
  const exercise = createExercise();
  return {exercise, lastBrowserCopy: null, initialTabCopy: serializeExercise(exercise),
    notice: unreadable ? "The saved run could not be read. Start a new run here." : ""};
}

// Give each open tab a stable starting point, including a tab opened before its first action.
export function pinTabRun(raw: string) {
  write("sessionStorage", raw);
}

export function saveBrowserRun(exercise: Exercise, previousCopy: string | null): BrowserRun {
  const raw = serializeExercise(exercise);
  const browserSaved = write("localStorage", raw);
  const tabSaved = write("sessionStorage", raw);
  // A stale tab copy would otherwise mask a successful browser save on refresh.
  if (!tabSaved && browserSaved) write("sessionStorage", null);
  let notice = window.openEcuDesktop?.receiverRun ? "Desktop run saved." : "Run saved in this browser.";
  if (!browserSaved) notice = tabSaved
    ? "Saved in this tab. Download your worksheet before closing it."
    : "This run could not be saved. Download your worksheet before leaving.";
  return {exercise, lastBrowserCopy: browserSaved ? raw : previousCopy, notice};
}

export function resetBrowserRun(previousCopy: string | null): BrowserRun {
  const exercise = createExercise();
  // An empty tab still needs its own marker when another tab has a newer run.
  const tabCleared = write("sessionStorage", serializeExercise(exercise));
  const latest = read("localStorage");
  let browserCleared = latest !== undefined;
  if (latest != null) {
    let remove = latest === previousCopy;
    if (!remove) {
      // Keep a different tab's valid run. Reset can discard an unreadable backup.
      try { restoreExercise(latest); }
      catch { remove = true; }
    }
    if (remove) browserCleared = write("localStorage", null);
  }
  return {exercise, lastBrowserCopy: browserCleared ? null : previousCopy,
    notice: tabCleared && browserCleared ? "" : "Reset in this tab. Browser storage could not confirm the reset."};
}
