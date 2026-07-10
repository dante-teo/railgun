export const ENTER_ALTERNATE_SCREEN = "\u001b[?1049h";
export const LEAVE_ALTERNATE_SCREEN = "\u001b[?1049l";
export const ENABLE_MOUSE_TRACKING = "\u001b[?1000h\u001b[?1006h";
export const DISABLE_MOUSE_TRACKING = "\u001b[?1006l\u001b[?1000l";

export const shouldUseAlternateScreen = (isTTY: boolean, screenReaderEnabled: boolean): boolean =>
  isTTY && !screenReaderEnabled;

const runWithTerminalMode = async <T>(
  write: (sequence: string) => unknown,
  enabled: boolean,
  enter: string,
  leave: string,
  run: () => Promise<T>,
): Promise<T> => {
  if (!enabled) return run();
  write(enter);
  try {
    return await run();
  } finally {
    write(leave);
  }
};

export const runInAlternateScreen = <T>(
  write: (sequence: string) => unknown,
  enabled: boolean,
  run: () => Promise<T>,
): Promise<T> => runWithTerminalMode(write, enabled, ENTER_ALTERNATE_SCREEN, LEAVE_ALTERNATE_SCREEN, run);

export const runWithMouseTracking = <T>(
  write: (sequence: string) => unknown,
  enabled: boolean,
  run: () => Promise<T>,
): Promise<T> => runWithTerminalMode(write, enabled, ENABLE_MOUSE_TRACKING, DISABLE_MOUSE_TRACKING, run);
