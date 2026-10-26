import { describe, expect, it } from 'vitest';
import { withGitHubRequestDeadline } from '../src/server/delivery-github-request-deadline.js';

describe('bounded GitHub request boundary', () => {
  it.each([0, 99, 60_001, Number.NaN, 1.5])(
    'rejects invalid request deadline %s before dispatch',
    async (timeoutMs) => {
      let dispatched = false;
      await expect(
        withGitHubRequestDeadline(
          async () => {
            dispatched = true;
            return 200;
          },
          { timeoutMs },
        ),
      ).rejects.toThrow('Invalid GitHub request deadline');
      expect(dispatched).toBe(false);
    },
  );

  it('rejects spoofed abort signals before invoking the GitHub transport', async () => {
    for (const malformed of [
      { aborted: false },
      {
        aborted: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    ]) {
      let dispatched = false;
      await expect(
        withGitHubRequestDeadline(
          async () => {
            dispatched = true;
            return 200;
          },
          { signal: malformed as AbortSignal },
        ),
      ).rejects.toThrow('Invalid GitHub request abort signal');
      expect(dispatched).toBe(false);
    }
  });

  it('completes a successful request within its deadline', async () => {
    const value = await withGitHubRequestDeadline(async (signal) => {
      expect(signal.aborted).toBe(false);
      return { status: 200 };
    });
    expect(value.status).toBe(200);
  });

  it('times out a fetcher that ignores AbortSignal without leaking credentials', async () => {
    let signal: AbortSignal | undefined;
    await expect(
      withGitHubRequestDeadline(
        async (requestSignal) => {
          signal = requestSignal;
          return new Promise<never>(() => undefined);
        },
        { timeoutMs: 100 },
      ),
    ).rejects.toThrow('GitHub request timed out');
    expect(signal?.aborted).toBe(true);
  });

  it('rejects an already-aborted request without invoking its adapter', async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    await expect(
      withGitHubRequestDeadline(
        async () => {
          called = true;
          return 200;
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow('GitHub request aborted');
    expect(called).toBe(false);
  });

  it('cancels a pending adapter when the caller aborts', async () => {
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    const pending = withGitHubRequestDeadline(
      async (requestSignal) => {
        signal = requestSignal;
        return new Promise<never>(() => undefined);
      },
      { signal: controller.signal, timeoutMs: 1_000 },
    );
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toThrow('GitHub request aborted');
    expect(signal?.aborted).toBe(true);
  });
});
