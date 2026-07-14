export interface MutationQueue {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export const createMutationQueue = (): MutationQueue => {
  let tail = Promise.resolve();
  return {
    run: <T>(operation: () => Promise<T>): Promise<T> => {
      const pending = tail.then(operation);
      tail = pending.then(() => undefined, () => undefined);
      return pending;
    },
  };
};
