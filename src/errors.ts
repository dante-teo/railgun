import { DevinApiError, DevinAuthError, DevinProtocolError } from "widevin";

export const describeDevinError = (error: unknown): string | undefined => {
  if (error instanceof DevinAuthError) return `Devin login failed: ${error.message}`;
  if (error instanceof DevinApiError) return `Devin API request failed (${error.status}): ${error.message}`;
  if (error instanceof DevinProtocolError) return `Devin protocol error: ${error.message}`;
  return undefined;
};
