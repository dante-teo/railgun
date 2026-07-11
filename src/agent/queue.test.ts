import { describe, expect, it } from "vitest";
import { createMessageQueues } from "./queue.js";

describe("message queues", () => {
  it("drains steering FIFO one item at a time and follow-ups all at once", () => {
    const queues = createMessageQueues();
    queues.enqueueSteer("one");
    queues.enqueueSteer("two");
    queues.enqueueFollowUp("later one");
    queues.enqueueFollowUp("later two");

    expect(queues.takeSteer()).toBe("one");
    expect(queues.takeSteer()).toBe("two");
    expect(queues.takeSteer()).toBeUndefined();
    expect(queues.takeFollowUps()).toEqual(["later one", "later two"]);
    expect(queues.takeFollowUps()).toEqual([]);
  });

  it("clears both queues and reports the cancelled count", () => {
    const queues = createMessageQueues();
    queues.enqueueSteer("one");
    queues.enqueueFollowUp("two");
    queues.enqueueFollowUp("three");

    expect(queues.clear()).toBe(3);
    expect(queues.clear()).toBe(0);
  });
});
