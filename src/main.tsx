import React from "react";
import ReactDOM from "react-dom/client";
import { DockApp } from "./app/DockApp";
import { SettingsApp } from "./features/settings/SettingsApp";
import "./styles/global.css";

const requested = new URLSearchParams(window.location.search).get("window");
const isSettings = requested === "settings" || window.location.hash.startsWith("#/settings");

function Root() {
  if (isSettings) return <SettingsApp />;
  return <DockApp />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
