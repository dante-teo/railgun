import { describeDevinError } from "./errors.js";
import { runOneShot } from "./oneShot.js";
import { runRepl } from "./repl/App.js";
import { initDevinSession } from "./session.js";

// Piping stdout into a command that closes early (e.g. `| head`) makes further
// writes fail with EPIPE, which Node reports as an unhandled stream error and
// would otherwise crash the process past the DevinError handling below.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);

  if (args[0] === "--print" || args[0] === "-p") {
    await runOneShot(args.slice(1).join(" ") || "Hello!");
    return;
  }

  if (args.length > 0) {
    console.error("Usage: railgun [--print|-p <question>]");
    process.exitCode = 1;
    return;
  }

  const session = await initDevinSession();
  await runRepl(session);
};

main().catch((error: unknown) => {
  const message = describeDevinError(error);
  console.error(message ?? error);
  process.exitCode = 1;
});
