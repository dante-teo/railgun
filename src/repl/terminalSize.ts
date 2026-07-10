import { useCallback, useEffect, useState } from "react";
import { useStdout } from "ink";

export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

interface DimensionSource {
  readonly columns?: number;
  readonly rows?: number;
}

export const readTerminalSize = (source: DimensionSource): TerminalSize => ({
  columns: source.columns ?? 80,
  rows: source.rows ?? 24,
});

export const useTerminalSize = (): TerminalSize => {
  const { stdout } = useStdout();
  const read = useCallback(() => readTerminalSize(stdout), [stdout]);
  const [size, setSize] = useState(read);
  useEffect(() => {
    const resize = (): void => setSize(read());
    stdout.on("resize", resize);
    return () => { stdout.off("resize", resize); };
  }, [read, stdout]);
  return size;
};
