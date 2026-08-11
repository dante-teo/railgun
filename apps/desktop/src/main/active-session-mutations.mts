export interface ActiveSessionMutationQueue {
  readonly run: <Result>(mutation: () => Promise<Result>) => Promise<Result>
}

export function createActiveSessionMutationQueue(): ActiveSessionMutationQueue {
  let tail: Promise<void> = Promise.resolve()

  const run = <Result,>(mutation: () => Promise<Result>): Promise<Result> => {
    const result = tail.then(mutation)
    tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  return { run }
}
