import { describe, expect, it } from 'vitest';
import { withGitHubRequestDeadline } from '../src/server/delivery-github-request-deadline.js';

describe('GitHub deadline cancellation races', () => {
  it('does not dispatch when aborted before adapter starts', async () => {
    const controller = new AbortController();
    let called = false;
    const pending = withGitHubRequestDeadline(async () => {
      called = true;
      return 200;
    }, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow('GitHub request aborted');
    expect(called).toBe(false);
  });

  it('rejects a delayed successful response after cancellation', async () => {
    const controller = new AbortController();
    let complete!: (value: number) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const pending = withGitHubRequestDeadline(async () => {
      started();
      return new Promise<number>((resolve) => { complete = resolve; });
    }, { signal: controller.signal });
    await entered;
    controller.abort();
    complete(201);
    await expect(pending).rejects.toThrow('GitHub request aborted');
  });
});
