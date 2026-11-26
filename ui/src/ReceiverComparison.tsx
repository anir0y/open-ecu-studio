import { memo, useEffect, useState } from "react";
import { ControlSlot, useControlWindow } from "./ControlWindow";
import { downloadCsv } from "./download-csv";
import { decodePacket, latestHandlePull, receiverWorksheetCsv, spacedHex } from "./packets";
import { applyExerciseAction, type Exercise, type ExerciseAction, type ExerciseCar } from "./receiver-exercise";
import { loadBrowserRun, pinTabRun, resetBrowserRun, saveBrowserRun } from "./receiver-storage";
import { TwinCarView } from "./TwinCarView";
import "./receiver-comparison.css";

function ByteStrip({data, peer, label = "Indexed CAN payload"}: {data: string; peer?: string; label?: string}) {
  return <div className="comparison-bytes" aria-label={label}>
    {Array.from({length: data.length / 2}, (_, index) => {
      const hex = data.slice(index * 2, index * 2 + 2);
      const differs = peer !== undefined && hex !== peer.slice(index * 2, index * 2 + 2);
      return <span key={index} data-diff={differs}
        aria-label={`Byte ${index}, ${hex}${differs ? ", differs between cars" : ""}`}>
        <small>B{index}</small><code>{hex}</code>
      </span>;
    })}
  </div>;
}

function ReceiverCard({name, car, peer, action, saved, handle}: {
  name: string; car: ExerciseCar; peer: ExerciseCar; action: Exercise["lastAction"]; saved: Exercise["savedPress"];
  handle?: string;
}) {
  const receipt = car.receipt;
  const decision = receipt && decodePacket({id: "0x362", data: receipt, is_fd: false}).fields[0].result;
  const newReceipt = action === "press" || action === "old_unlock";
  return <article className="comparison-card" aria-label={name}>
    <h3>{name}</h3>
    <div className="comparison-state">
      <strong>{car.locked ? "Locked" : "Unlocked"}</strong>
      <span>Left door {car.open ? "open" : "closed"}</span>
    </div>
    <div className="comparison-exchange">
      <div className="comparison-report comparison-saved">
        <h4>Saved fob packet</h4>
        {saved ? <>
          <p>Unlock · press #{saved.counter}</p>
          <ByteStrip data={saved.data} label="Saved virtual fob bytes" />
        </> : <p>Waiting for a saved press</p>}
      </div>
      <div className="comparison-report">
        <h4><code>0x362</code> Fob decision</h4>
        {receipt && car.receiptInput ? <>
          <p>{decision} · press #{car.receiptInput.counter} · {newReceipt ? "New frame" : "Previous fob frame"}</p>
          <ByteStrip data={receipt} peer={peer.receipt ?? undefined} />
          {saved && saved.data !== car.receiptInput.data && <p className="comparison-used">Input for this decision <code>{spacedHex(car.receiptInput.data)}</code></p>}
        </> : <p>Waiting for a fob press</p>}
      </div>
    </div>
    <div className="comparison-report">
      <h4><code>0x361</code> Body status</h4>
      <p>{action === "ready" ? "Initial body state" : car.bodySent ? "New frame" : "Last known frame · no update"}</p>
      <ByteStrip data={car.body} peer={peer.body} />
      {handle && <p>{handle}</p>}
    </div>
  </article>;
}

function actionText(exercise: Exercise) {
  switch (exercise.lastAction) {
    case "ready": return "Both cars are locked. Press the virtual fob to create an unlock packet.";
    case "press": return `Both cars accepted fresh unlock #${exercise.lastPress?.counter}.`;
    case "save": return `Unlock #${exercise.savedPress?.counter} is saved for both cars. Saving a press keeps the current door states.`;
    case "lock": return exercise.vulnerable.open || exercise.protected.open
      ? "An open door stayed unlocked. Close both doors to lock them."
      : "Both cars are locked. Read B3 in their body status frames.";
    case "old_unlock": return `Both received saved unlock #${exercise.savedPress?.counter}. Compare B0 for the decision and B6 for the lock state.`;
    case "handles": return `Both left handles were pulled. Vulnerable door ${exercise.vulnerable.open ? "open" : "closed"}, protected door ${exercise.protected.open ? "open" : "closed"}. Look at bit 0 of B2 in body status.`;
    case "close": return "Both doors are closed. The cars can be locked again.";
  }
}

export const ReceiverComparison = memo(function ReceiverComparison() {
  const {detached} = useControlWindow();
  const [run, setRun] = useState(loadBrowserRun);
  useEffect(() => {
    if (run.initialTabCopy) pinTabRun(run.initialTabCopy);
  }, [run.initialTabCopy]);
  const {exercise} = run;
  const { lastPress, savedPress } = exercise;
  const pull = latestHandlePull(exercise);
  const alreadySaved = Boolean(savedPress && lastPress?.counter === savedPress.counter);
  function act(action: ExerciseAction) {
    const next = applyExerciseAction(exercise, action);
    if (next !== exercise) setRun(saveBrowserRun(next, run.lastBrowserCopy));
  }
  function downloadRun(owner: Document) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadCsv(`receiver-run-${stamp}.csv`, receiverWorksheetCsv(exercise), owner);
  }
  const resetButton = <button type="button" className="comparison-reset"
    onClick={() => setRun(resetBrowserRun(run.lastBrowserCopy))}>Reset exercise</button>;
  return <section id="receiver-comparison" className="receiver-comparison" aria-labelledby="comparison-heading">
    <header className="comparison-heading">
      <div>
        <h2 id="comparison-heading">Live receiver comparison</h2>
        <p>Press the virtual fob and save its packet. Lock both cars, try the saved packet, then pull the handles.</p>
      </div>
      {!detached && resetButton}
    </header>
    <div className="comparison-fob" role="group" aria-label="Virtual fob">
      <ControlSlot group="receiver">
        {detached && <h2 className="comparison-remote-heading">Virtual fob</h2>}
        <div className="comparison-commands">
          <button type="button" onClick={() => act("press")}>Press fob unlock</button>
          <button type="button" disabled={!lastPress || alreadySaved} aria-describedby={detached ? "remote-press-info" : "saved-press-info"} onClick={() => act("save")}>Save packet</button>
        </div>
        {detached && <p id="remote-press-info" className="comparison-remote-status" role="status">
          {lastPress ? `Latest unlock #${lastPress.counter} · ` : ""}{savedPress ? `Saved unlock #${savedPress.counter}` : "No saved packet"}
        </p>}
      </ControlSlot>
      <div className="comparison-press"><span>Latest press</span>
        {lastPress ? <><strong>#{lastPress.counter}</strong><code>{spacedHex(lastPress.data)}</code></> : <strong>—</strong>}
      </div>
      <div className="comparison-press" id="saved-press-info"><span>Saved for this exercise</span><strong>{savedPress ? `#${savedPress.counter}` : "Empty"}</strong>
        {savedPress && lastPress && !alreadySaved && <small>Save packet replaces #{savedPress.counter} with #{lastPress.counter}.</small>}
      </div>
      <p className="comparison-format">B0 is <code>55</code> (U for unlock). B1–B4 hold the press number, most significant byte first. Each decision echoes that number in B2–B5.</p>
    </div>
    <ControlSlot group="receiver">
      {detached && <h2 className="comparison-remote-heading">Both cars</h2>}
      <div className="comparison-commands" role="group" aria-label="Operate both cars">
        <button type="button" onClick={() => act("lock")}>Lock both cars</button>
        <button type="button" disabled={!savedPress} onClick={() => act("old_unlock")}>Try saved packet</button>
        <button type="button" onClick={() => act("handles")}>Pull both handles</button>
        <button type="button" onClick={() => act("close")}>Close both doors</button>
      </div>
      {detached && <p className="comparison-remote-status" role="status">{actionText(exercise)}</p>}
    </ControlSlot>
    <p className="comparison-input" role="status" aria-atomic="true">
      <strong>{exercise.lastAction === "ready" ? "Ready" : `Action ${exercise.step}`}</strong>
      <span>{actionText(exercise)}</span>
    </p>
    <TwinCarView vulnerableOpen={exercise.vulnerable.open} protectedOpen={exercise.protected.open} />
    <div className="comparison-pair">
      <ReceiverCard name="Vulnerable receiver" car={exercise.vulnerable} peer={exercise.protected} action={exercise.lastAction} saved={savedPress}
        handle={pull && `Last handle pull · Step ${pull.step} · ${pull.vulnerable}`} />
      <ReceiverCard name="Protected receiver" car={exercise.protected} peer={exercise.vulnerable} action={exercise.lastAction} saved={savedPress}
        handle={pull && `Last handle pull · Step ${pull.step} · ${pull.protected}`} />
    </div>
    <footer>
      <p>The saved bytes represent a virtual fob press. Underlined bytes mark differences between the cars’ simulated CAN reports.</p>
      <ControlSlot group="receiver">
        <div className="comparison-export">
          <button type="button" disabled={exercise.step === 0} onClick={e => downloadRun(e.currentTarget.ownerDocument)} aria-describedby="run-length">Download run worksheet (CSV)</button>
          <span id="run-length">{exercise.step === 0 ? "Take an action to start your worksheet." : `${exercise.step} recorded ${exercise.step === 1 ? "action" : "actions"} since reset`}</span>
        </div>
        {detached && resetButton}
      </ControlSlot>
      {run.notice && <p role="status" className="comparison-persistence">{run.notice}</p>}
    </footer>
  </section>;
});
