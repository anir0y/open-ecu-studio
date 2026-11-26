import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState,
  type KeyboardEvent, type ReactNode,
} from "react";
import {createPortal} from "react-dom";
import "./control-window.css";

const groups = ["drive", "body", "receiver", "analysis"] as const;
export type ControlGroup = typeof groups[number];

const destinations: Record<ControlGroup, string> = {
  drive: "drive-lab", body: "drive-lab", receiver: "receiver-comparison", analysis: "esc-event",
};
const labels: Record<ControlGroup, string> = {
  drive: "Drive", body: "Body", receiver: "Receiver", analysis: "Analysis",
};

type Panel = {
  popup: Window;
  document: Document;
  header: HTMLElement;
  slots: Record<ControlGroup, HTMLElement>;
};

type WindowState = {
  detached: boolean;
  popup: Window | null;
  error: string | null;
  detach: () => void;
  dock: () => void;
  focus: (group?: ControlGroup) => void;
};

const WindowContext = createContext<WindowState | null>(null);
const PortalContext = createContext<Panel | null>(null);

function preparePanel(popup: Window): Panel {
  const doc = popup.document;
  doc.title = "Open ECU Studio Controls";
  doc.documentElement.lang = document.documentElement.lang || "en";
  const base = doc.createElement("base");
  base.href = document.baseURI;
  doc.head.append(base);
  document.head.querySelectorAll('style, link[rel~="stylesheet"]').forEach(style => {
    doc.head.append(doc.importNode(style, true));
  });
  doc.body.className = "controls-window";
  const header = doc.createElement("header");
  header.className = "controls-window-header";
  doc.body.append(header);
  const slots = {} as Panel["slots"];
  for (const group of groups) {
    const slot = doc.createElement("section");
    slot.className = "controls-window-panel";
    slot.id = `panel-${group}`;
    slot.setAttribute("role", "tabpanel");
    slot.setAttribute("aria-labelledby", `tab-${group}`);
    slot.tabIndex = 0;
    slot.hidden = group !== "drive";
    doc.body.append(slot);
    slots[group] = slot;
  }
  return {popup, document: doc, header, slots};
}

function showMainSection(id: string) {
  if (window.location.hash === `#${id}`) {
    document.getElementById(id)?.scrollIntoView({block: "start"});
  } else {
    window.location.hash = id;
  }
}

export function ControlWindowProvider({children}: {children: ReactNode}) {
  const current = useRef<Panel | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [group, setGroup] = useState<ControlGroup>("drive");
  const [error, setError] = useState<string | null>(null);

  const dock = useCallback(() => {
    const active = current.current;
    if (!active) return;
    current.current = null;
    setPanel(null);
    if (!active.popup.closed) active.popup.close();
    window.requestAnimationFrame(() => {
      const button = trigger.current?.isConnected ? trigger.current : document.getElementById("detach-controls");
      button?.focus({preventScroll: true});
    });
  }, []);

  const select = (next: ControlGroup) => {
    setGroup(next);
    showMainSection(destinations[next]);
  };
  const focus = (next?: ControlGroup) => {
    if (next) select(next);
    const active = current.current;
    if (active && !active.popup.closed) {
      active.popup.focus();
      active.document.getElementById(`tab-${next ?? group}`)?.focus();
    }
  };

  const detach = () => {
    if (current.current && !current.current.popup.closed) {
      focus();
      return;
    }
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let popup: Window | null = null;
    try {
      const left = window.screenX + Math.max(0, window.outerWidth - 430);
      popup = window.open("about:blank", "open-ecu-studio-controls",
        `popup=yes,width=430,height=740,left=${left},top=${window.screenY}`);
      if (!popup) throw new Error("Pop-up blocked");
      const next = preparePanel(popup);
      current.current = next;
      setPanel(next);
      setError(null);
      select("drive");
      popup.focus();
    } catch {
      popup?.close();
      setError("The controls window could not open. Allow pop-ups for this app and try again.");
    }
  };

  useEffect(() => {
    if (!panel) return;
    const close = () => { if (current.current === panel) dock(); };
    // Native window closing and browser reloads can discard the child document independently.
    const check = window.setInterval(() => {
      try {
        if (panel.popup.closed || panel.popup.document !== panel.document) close();
      } catch {
        close(); // A browser user navigated the controls window to a different origin.
      }
    }, 250);
    panel.popup.addEventListener("pagehide", close);
    window.addEventListener("pagehide", close);
    panel.document.getElementById("tab-drive")?.focus();
    return () => {
      window.clearInterval(check);
      window.removeEventListener("pagehide", close);
      if (!panel.popup.closed) {
        try { panel.popup.removeEventListener("pagehide", close); } catch { /* Navigated away. */ }
        panel.popup.close();
      }
    };
  }, [panel, dock]);

  useLayoutEffect(() => {
    if (panel) groups.forEach(name => { panel.slots[name].hidden = name !== group; });
  }, [panel, group]);

  const moveTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: ControlGroup;
    switch (event.key) {
      case "ArrowRight": next = groups[(index + 1) % groups.length]; break;
      case "ArrowLeft": next = groups[(index + groups.length - 1) % groups.length]; break;
      case "Home": next = groups[0]; break;
      case "End": next = groups[groups.length - 1]; break;
      default: return;
    }
    event.preventDefault();
    focus(next);
  };

  return <WindowContext.Provider value={{detached: !!panel, popup: panel?.popup ?? null, detach, dock, focus, error}}>
    <PortalContext.Provider value={panel}>{children}</PortalContext.Provider>
    {panel && createPortal(<>
      <div className="controls-window-title">
        <h1>Vehicle controls</h1><button type="button" onClick={dock}>Dock controls</button>
      </div>
      <div className="controls-window-tabs" role="tablist" aria-label="Control groups">
        {groups.map((name, index) => <button key={name} id={`tab-${name}`} type="button" role="tab"
          aria-controls={`panel-${name}`} aria-selected={name === group} tabIndex={name === group ? 0 : -1}
          onClick={() => select(name)} onKeyDown={event => moveTab(event, index)}>{labels[name]}</button>)}
      </div>
    </>, panel.header)}
  </WindowContext.Provider>;
}

export function useControlWindow(): WindowState {
  const state = useContext(WindowContext);
  if (!state) throw new Error("ControlWindowProvider must wrap the studio");
  return state;
}

export function ControlSlot({group, children}: {group: ControlGroup; children: ReactNode}) {
  const panel = useContext(PortalContext);
  return panel ? createPortal(children, panel.slots[group]) : <>{children}</>;
}
