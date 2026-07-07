import type { DevinMessage, DevinProvider } from "widevin";

export type TurnOutcome =
  | { ok: true; messages: readonly DevinMessage[]; assistantText: string }
  | { ok: false; error: unknown };

export const runTurn = async (
  devin: DevinProvider,
  model: string,
  history: readonly DevinMessage[],
  userText: string,
  onDelta?: (delta: string) => void
): Promise<TurnOutcome> => {
  const withUser: DevinMessage[] = [...history, { role: "user", content: userText }];
  let assistantText = "";

  try {
    for await (const event of devin.streamChat({ model, messages: withUser })) {
      if (event.type === "text_delta") {
        assistantText += event.delta;
        onDelta?.(event.delta);
      }
    }
  } catch (error) {
    return { ok: false, error };
  }

  const withAssistant: DevinMessage[] = [
    ...withUser,
    { role: "assistant", content: [{ type: "text", text: assistantText }] }
  ];
  return { ok: true, messages: withAssistant, assistantText };
};
