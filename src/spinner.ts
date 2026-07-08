const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const startSpinner = (label: string): ((isError: boolean) => void) => {
  let i = 0;
  const interval = setInterval(() => {
    process.stderr.write(`\r${FRAMES[i++ % FRAMES.length]} ${label}`);
  }, 80);
  return (isError: boolean) => {
    clearInterval(interval);
    process.stderr.write(`\r${isError ? "✗" : "✓"} ${label}\n`);
  };
};
