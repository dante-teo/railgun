import type { DevinMessage } from "widevin";

export type AdviceSeverity = "nit" | "concern" | "blocker";

export interface AdvisoryContext {
  readonly steer: (text: string) => void;
  /** @deprecated Retained for API compatibility; advisory delivery uses steer. */
  readonly appendToPrimary: (msg: DevinMessage) => void;
  readonly dedupe: Set<string>;
  notesThisUpdate: number;
}
