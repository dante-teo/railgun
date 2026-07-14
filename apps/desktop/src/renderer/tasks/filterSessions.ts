import type { SessionSummary } from "../../shared/types";

export const filterSessions = (sessions: readonly SessionSummary[], query: string): readonly SessionSummary[] => {
  const normalized = query.trim().toLocaleLowerCase();
  return normalized === "" ? sessions : sessions.filter(session =>
    [session.firstUserPreview, session.model, session.id].some(value => value.toLocaleLowerCase().includes(normalized)));
};
