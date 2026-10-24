import { describe, expect, it } from 'vitest';
import {
  decidePublication,
  publicationKey,
  type PublicationReceipt,
} from '../src/server/delivery-publication-idempotency.js';
import type { DeliveryPublicationPlan } from '../src/server/delivery-publication-policy.js';

const plan: DeliveryPublicationPlan = {
  allowed: true,
  destination: 'https://github.com/vlovers/ai-office',
  branch: 'ai-office/12345678-1234-1234-1234-123456789abc',
  baseBranch: 'main',
  revision: 'a'.repeat(64),
  draft: true,
};
const receipt: PublicationReceipt = {
  destination: 'https://github.com/vlovers/ai-office',
  branch: 'ai-office/12345678-1234-1234-1234-123456789abc',
  baseBranch: 'main',
  revision: 'a'.repeat(64),
  draft: true,
  pullRequestUrl: 'https://github.com/vlovers/ai-office/pull/42',
};

describe('delivery publication idempotency', () => {
  it('creates only when no receipt exists', () => {
    expect(decidePublication(plan, null)).toEqual({
      action: 'create',
      key: publicationKey(plan as Extract<DeliveryPublicationPlan, { allowed: true }>),
    });
  });

  it('reuses an exact matching draft receipt', () => {
    expect(decidePublication(plan, receipt)).toMatchObject({
      action: 'reuse',
      pullRequestUrl: receipt.pullRequestUrl,
    });
  });

  it('blocks stale, changed or malformed publication receipts', () => {
    for (const patch of [
      { revision: 'b'.repeat(64) },
      { branch: 'main' },
      { destination: 'https://github.com/other/repo' },
      { baseBranch: 'develop' },
      { draft: false },
      { pullRequestUrl: 'https://evil.example/pull/42' },
      { pullRequestUrl: 'https://github.com/vlovers/ai-office/pull/42/edit' },
    ]) {
      expect(decidePublication(plan, { ...receipt, ...patch } as PublicationReceipt).action).toBe(
        'blocked',
      );
    }
  });

  it('never creates a publication from a blocked plan', () => {
    expect(decidePublication({ allowed: false, reason: 'Stale review' }, null)).toEqual({
      action: 'blocked',
      reason: 'Stale review',
    });
  });
});
