import { homedir } from "node:os";
import { join } from "node:path";
import { createDevinProvider, createFileTokenStore, DevinApiError, DevinAuthError, DevinProtocolError } from "widevin";
import { openUrlInBrowser } from "./openBrowser.js";

const TOKEN_PATH = join(homedir(), ".railgun", "devin-token");

// Piping stdout into a command that closes early (e.g. `| head`) makes further
// writes fail with EPIPE, which Node reports as an unhandled stream error and
// would otherwise crash the process past the DevinError handling below.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

const main = async (): Promise<void> => {
  const question = process.argv.slice(2).join(" ") || "Hello!";
  const tokenStore = createFileTokenStore(TOKEN_PATH);
  const devin = createDevinProvider({ tokenStore, openBrowser: openUrlInBrowser });

  if (!(await tokenStore.get())) {
    await devin.login();
  }

  const models = await devin.listModels();
  const model = models[0];
  if (!model) throw new Error("Devin returned no available models");
  console.error(`Using model: ${model.id}`);

  for await (const event of devin.streamChat({
    model: model.id,
    messages: [{ role: "user", content: question }]
  })) {
    if (event.type === "text_delta") {
      process.stdout.write(event.delta);
    } else if (event.type === "done") {
      process.stdout.write("\n");
    }
  }
};

main().catch((error: unknown) => {
  if (error instanceof DevinAuthError) {
    console.error(`Devin login failed: ${error.message}`);
  } else if (error instanceof DevinApiError) {
    console.error(`Devin API request failed (${error.status}): ${error.message}`);
  } else if (error instanceof DevinProtocolError) {
    console.error(`Devin protocol error: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
