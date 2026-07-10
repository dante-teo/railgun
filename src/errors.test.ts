import { describe, expect, it } from "vitest";
import { DevinApiError, DevinProtocolError } from "widevin";
import { CredentialRejectedError, LoginVerificationError } from "./auth.js";
import { describeDevinError } from "./errors.js";

describe("describeDevinError authentication guidance", () => {
  it("reports cached credential removal and directs the user to login without exposing API details", () => {
    const error = new CredentialRejectedError("file", new DevinApiError("secret-bearing response", 401));
    const message = describeDevinError(error);
    expect(message).toContain("cached credential was removed");
    expect(message).toContain("railgun login");
    expect(message).not.toContain("secret-bearing response");
  });

  it("reports removal failures while preserving the original 401 context", () => {
    const error = new CredentialRejectedError(
      "file",
      new DevinApiError("unauthorized", 401),
      new Error("permission denied"),
    );
    expect(describeDevinError(error)).toMatch(/rejected.*401.*removal.*permission denied.*railgun login/i);
  });

  it("directs rejected environment credentials to be updated or unset", () => {
    const error = new CredentialRejectedError("environment", new DevinApiError("unauthorized", 401));
    expect(describeDevinError(error)).toMatch(/DEVIN_TOKEN.*update or unset/i);
  });

  it("preserves API/protocol formatting inside saved-but-unverified login context", () => {
    expect(describeDevinError(new LoginVerificationError(new DevinApiError("busy", 503))))
      .toBe("Devin credentials were saved, but verification failed: Devin API request failed (503): busy");
    expect(describeDevinError(new LoginVerificationError(new DevinProtocolError("bad payload"))))
      .toBe("Devin credentials were saved, but verification failed: Devin protocol error: bad payload");
  });
});
