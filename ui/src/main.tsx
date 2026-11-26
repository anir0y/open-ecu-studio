import "@fontsource/barlow-condensed/500.css";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource-variable/ibm-plex-sans";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { ControlWindowProvider } from "./ControlWindow";
import "./dbc-workspace.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ControlWindowProvider><App /></ControlWindowProvider>
  </StrictMode>,
);
