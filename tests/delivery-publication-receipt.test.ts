import { describe, expect, it } from 'vitest';
import { validatePublicationReceipt } from '../src/server/delivery-publication-receipt.js';

const plan = {
  allowed: true as const,
  destination: 'https://github.com/vlovers/ai-office',
  branch: 'ai-office/12345678-1234-1234-1234-123456789abc',
  baseBranch: 'main',
  revision: 'a'.repeat(64),
  draft: true as const,
};
const repo = { full_name: 'vlovers/ai-office' };
const receipt = {
  html_url: 'https://github.com/vlovers/ai-office/pull/123',
  draft: true,
  state: 'open',
  head: { ref: plan.branch, repo },
  base: { ref: 'main', repo },
};

describe('GitHub publication receipt verification', () => {
  it('accepts a matching draft in the approved repository', () => {
    expect(validatePublicationReceipt(plan, receipt)).toBe(receipt.html_url);
  });

  it.each([
    [{ ...receipt, draft: false }, 'does not match'],
    [{ ...receipt, state: 'closed' }, 'does not match'],
    [{ ...receipt, head: { ref: 'other-branch', repo } }, 'does not match'],
    [{ ...receipt, base: { ref: 'develop', repo } }, 'does not match'],
    [
      { ...receipt, head: { ref: plan.branch, repo: { full_name: 'evil/fork' } } },
      'does not match',
    ],
    [
      { ...receipt, base: { ref: 'main', repo: { full_name: 'evil/fork' } } },
      'does not match',
    ],
    [{ ...receipt, head: { ref: plan.branch, repo: null } }, 'does not match'],
    [
      { ...receipt, html_url: 'https://github.com/attacker/repo/pull/123' },
      'approved destination',
    ],
    [
      { ...receipt, html_url: 'https://github.com/vlovers/ai-office/pull/123?x=1' },
      'approved destination',
    ],
  ])('rejects a mismatched remote receipt', (candidate, reason) => {
    expect(() => validatePublicationReceipt(plan, candidate)).toThrow(reason);
  });

  it('rejects blocked publication plans', () => {
    expect(() =>
      validatePublicationReceipt({ allowed: false, reason: 'review stale' }, receipt),
    ).toThrow('blocked');
  });
});
