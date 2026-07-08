export const DEFAULT_ITERATION_BUDGET = 90;

export const ITERATION_LIMIT_MESSAGE =
  "I've reached the iteration limit for this session, so I'm stopping here gracefully.";

export type IterationBudget = Readonly<{
  consume: () => boolean;
  remaining: () => number;
}>;

export const IterationBudget = Object.freeze({
  create: (max = DEFAULT_ITERATION_BUDGET): IterationBudget => {
    let remaining = Math.max(0, max);

    return Object.freeze({
      consume: () => {
        if (remaining <= 0) return false;
        remaining -= 1;
        return true;
      },
      remaining: () => remaining,
    });
  },
});
