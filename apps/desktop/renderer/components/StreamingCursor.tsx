import type React from "react";
import { glyphs } from "../lib/theme.js";

export const StreamingCursor: React.FC = () => (
  <span className="streaming-cursor" aria-hidden="true">
    {glyphs.streamingCursor}
  </span>
);
