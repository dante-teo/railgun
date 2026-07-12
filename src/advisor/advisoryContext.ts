import type { DevinMessage } from "widevin";

export type AdviceSeverity = "nit" | "concern" | "blocker";

export interface AdvisoryContext {
  readonly steer: (text: string) => void;
  readonly appendToPrimary: (msg: DevinMessage) => void;
  readonly dedupe: Set<string>;
  notesThisUpdate: number;
}
