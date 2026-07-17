import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const canonicalIconPath = resolve(
  import.meta.dirname,
  "../../../macos/Resources/RailgunIcon/RailgunIcon-1024.png",
);
const packagedIconPath = resolve(import.meta.dirname, "../../assets/railgun-icon.png");

describe("desktop icon assets", () => {
  it("keeps the packaged About icon synchronized with the canonical Railgun artwork", () => {
    expect(readFileSync(packagedIconPath)).toEqual(readFileSync(canonicalIconPath));
  });
});
