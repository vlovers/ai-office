/**
 * A bounded GitHub request including response body parsing.
 *
 * AbortSignal alone is insufficient for injected fetchers that ignore abort:
 * the promise race releases the Git lease and leaves any ambiguous POST
 * durably uncertain. The caller must never retry an ambiguous remote write.
 */
export type GitHubRequestDeadline = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export async function withGitHubRequestDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: GitHubRequestDeadline = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error('Invalid GitHub request deadline.');
  }
  if (options.signal?.aborted) throw new Error('GitHub request aborted.');

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('GitHub request timed out.'));
      controller.abort();
    }, timeoutMs);
    onAbort = () => {
      reject(new Error('GitHub request aborted.'));
      controller.abort();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new Error('GitHub request aborted.');
        return operation(controller.signal);
      }),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) options.signal?.removeEventListener('abort', onAbort);
  }
}
