export interface MessageQueues {
  readonly enqueueSteer: (text: string) => void;
  readonly enqueueFollowUp: (text: string) => void;
  readonly takeSteer: () => string | undefined;
  readonly takeFollowUps: () => readonly string[];
  readonly clear: () => number;
}

export const createMessageQueues = (): MessageQueues => {
  let steering: readonly string[] = [];
  let followUps: readonly string[] = [];

  return Object.freeze({
    enqueueSteer: (text: string) => { steering = [...steering, text]; },
    enqueueFollowUp: (text: string) => { followUps = [...followUps, text]; },
    takeSteer: () => {
      const [next, ...rest] = steering;
      steering = rest;
      return next;
    },
    takeFollowUps: () => {
      const queued = followUps;
      followUps = [];
      return queued;
    },
    clear: () => {
      const count = steering.length + followUps.length;
      steering = [];
      followUps = [];
      return count;
    },
  });
};
