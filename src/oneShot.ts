import { initDevinSession } from "./session.js";

export const runOneShot = async (question: string): Promise<void> => {
  const { devin, model } = await initDevinSession();

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
