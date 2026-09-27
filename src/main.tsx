import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

function allowsNativeContextMenu(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'input, textarea, [contenteditable="true"], [data-remotehand-native-context-menu="true"]',
    ),
  );
}

document.addEventListener(
  "contextmenu",
  (event) => {
    if (allowsNativeContextMenu(event.target)) return;
    event.preventDefault();
  },
  true,
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
