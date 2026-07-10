export type MouseWheelDirection = "up" | "down";

const SGR_MOUSE_EVENT = /(?:\u001b)?\[<(\d+);\d+;\d+[Mm]/g;

export const parseMouseWheel = (input: string): readonly MouseWheelDirection[] =>
  [...input.matchAll(SGR_MOUSE_EVENT)].flatMap(match => {
    const button = Number(match[1]);
    return (button & 64) === 0 ? [] : [(button & 1) === 0 ? "up" : "down"];
  });
