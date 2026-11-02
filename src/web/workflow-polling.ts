/**
 * Limit automatic workflow polling to one outstanding refresh per selection.
 * Explicit user refreshes can still bypass this gate.
 */
export function createSingleFlight() {
  let pending: Promise<void> | null = null;
  return {
    run(work: () => Promise<void>): Promise<void> {
      if (pending) return pending;
      const current = Promise.resolve().then(work);
      pending = current;
      const clear = () => {
        if (pending === current) pending = null;
      };
      // Observe rejection here without swallowing it for callers of run().
      void current.then(clear, clear);
      return current;
    },
    reset(): void {
      // A previous selection's completion must not unlock the new selection.
      pending = null;
    },
  };
}

/** Abort stuck read-only polling requests so the next tick can recover. */
export function createRequestDeadline(timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    get timedOut(): boolean {
      return timedOut;
    },
    cancel(): void {
      controller.abort();
    },
    dispose(): void {
      clearTimeout(timer);
    },
  };
}
