import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { PreviewPanelProvider } from "./state/previewPanel";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PreviewPanelProvider>
      <App />
    </PreviewPanelProvider>
  </React.StrictMode>,
);
