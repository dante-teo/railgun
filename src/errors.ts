import { DevinApiError, DevinAuthError, DevinProtocolError } from "widevin";
import { CredentialRejectedError, LoginVerificationError } from "./auth.js";

const describeUnknown = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const describeRemovalFailure = (error: unknown): string =>
  ` Credential removal also failed: ${describeUnknown(error)}.`;

export const describeDevinError = (error: unknown): string | undefined => {
  if (error instanceof CredentialRejectedError) {
    if (error.source === "environment") {
      return "Devin rejected DEVIN_TOKEN (401). Update or unset DEVIN_TOKEN.";
    }
    const removal = error.removalFailure === undefined
      ? " The cached credential was removed."
      : describeRemovalFailure(error.removalFailure);
    return `Devin rejected the cached credential (401).${removal} Run railgun login.`;
  }
  if (error instanceof LoginVerificationError) {
    const detail = describeDevinError(error.verificationFailure) ?? describeUnknown(error.verificationFailure);
    return `Devin credentials were saved, but verification failed: ${detail}`;
  }
  if (error instanceof DevinAuthError) return `Devin login failed: ${error.message}`;
  if (error instanceof DevinApiError) return `Devin API request failed (${error.status}): ${error.message}`;
  if (error instanceof DevinProtocolError) return `Devin protocol error: ${error.message}`;
  return undefined;
};
