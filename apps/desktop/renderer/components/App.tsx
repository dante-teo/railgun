import React from "react";

/**
 * Production App shell — wired to the WebSocket gateway in Sprint 2.
 * Sprint 1 surfaces this via DevShell with mock data.
 */
export const App: React.FC = () => (
  <div className="app">
    <p style={{ padding: "var(--spacing-md)", color: "var(--color-muted)", fontFamily: "var(--font-mono)", fontSize: 13 }}>
      Connecting to gateway…
    </p>
  </div>
);
