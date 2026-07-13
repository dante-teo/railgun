import React, { useEffect } from "react";

export interface ShellApprovalProps {
  readonly command: string;
  readonly onApprove: () => void;
  readonly onDeny: () => void;
}

export const ShellApproval: React.FC<ShellApprovalProps> = ({ command, onApprove, onDeny }) => {
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === "y" || e.key === "Y") {
        e.preventDefault();
        onApprove();
      } else if (e.key === "n" || e.key === "N" || e.key === "Escape") {
        e.preventDefault();
        onDeny();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onApprove, onDeny]);

  return (
    <div className="approval-overlay" role="dialog" aria-modal="true" aria-label="Shell command approval">
      <div className="approval-overlay__title">APPROVAL · Run shell command</div>
      <div className="approval-overlay__command">{command}</div>
      <div className="approval-overlay__hint">[y] approve · [n] deny</div>
    </div>
  );
};
