import React from "react";

interface GitStatus {
  readonly branch: string | null;
  readonly dirty: boolean;
}

interface SessionMetadata {
  readonly sessionId: string;
  readonly messageId: number;
}

interface ActiveMoaPreset {
  readonly name: string;
}

interface StatusBarProps {
  readonly model: string;
  readonly gitStatus: GitStatus;
  readonly cwd: string;
  readonly sessionMetadata?: SessionMetadata;
  readonly unsaved: boolean;
  readonly activeMoaPreset: ActiveMoaPreset | null;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  model,
  gitStatus,
  cwd,
  sessionMetadata,
  unsaved,
  activeMoaPreset,
}) => (
  <div className="status-bar" role="status" aria-label="Session status">
    <div className="status-bar__left">
      {gitStatus.branch !== null && (
        <>
          <span>{gitStatus.branch}</span>
          {gitStatus.dirty && (
            <span className="status-bar__dirty-dot" title="Uncommitted changes" aria-label="Uncommitted changes" />
          )}
        </>
      )}
      {cwd && (
        <>
          {gitStatus.branch !== null && (
            <span className="status-bar__separator" aria-hidden="true">·</span>
          )}
          <span title="Working directory">{cwd}</span>
        </>
      )}
    </div>

    <div className="status-bar__center">
      {sessionMetadata !== undefined && (
        <span title={`Session ${sessionMetadata.sessionId}`}>
          #{sessionMetadata.messageId}
        </span>
      )}
    </div>

    <div className="status-bar__right">
      {activeMoaPreset !== null && (
        <span title="MoA preset">{activeMoaPreset.name}</span>
      )}
      <span title="Model">{model}</span>
      {unsaved && <span title="Unsaved checkpoint">●</span>}
    </div>
  </div>
);
