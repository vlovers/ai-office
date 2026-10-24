import { describe, expect, it } from 'vitest';
import {
  publicationReadiness,
  validateLeasedPublication,
} from '../src/server/delivery-publication-coordinator.js';
import { publicationKey } from '../src/server/delivery-publication-idempotency.js';
import type { DeliveryPublicationPlan } from '../src/server/delivery-publication-policy.js';

const plan = {
  allowed: true,
  destination: 'https://github.com/vlovers/ai-office',
  branch: 'ai-office/12345678-1234-1234-1234-123456789abc',
  baseBranch: 'main',
  revision: 'a'.repeat(64),
  draft: true,
} as const satisfies DeliveryPublicationPlan;

describe('publication coordinator', () => {
  it('requires a lease for a new reviewed snapshot', () => {
    expect(publicationReadiness(plan, null)).toEqual({
      status: 'requires-lease',
      operationKey: publicationKey(plan),
    });
  });

  it('blocks rejected plans before any lease or external operation', () => {
    expect(publicationReadiness({ allowed: false, reason: 'Review is stale.' }, null)).toEqual({
      status: 'blocked',
      reason: 'Review is stale.',
    });
  });

  it('recognizes an exact previously published draft', () => {
    expect(
      publicationReadiness(plan, {
        destination: plan.destination,
        branch: plan.branch,
        baseBranch: plan.baseBranch,
        revision: plan.revision,
        draft: true,
        pullRequestUrl: 'https://github.com/vlovers/ai-office/pull/45',
      }),
    ).toEqual({
      status: 'already-published',
      pullRequestUrl: 'https://github.com/vlovers/ai-office/pull/45',
    });
  });

  it('revalidates the exact plan after obtaining an exclusive lease', () => {
    const key = publicationKey(plan);
    expect(validateLeasedPublication(key, plan)).toEqual({ valid: true });
    expect(validateLeasedPublication(key, { ...plan, revision: 'b'.repeat(64) })).toMatchObject({
      valid: false,
    });
    expect(validateLeasedPublication(key, { allowed: false, reason: 'Preflight failed.' })).toEqual({
      valid: false,
      reason: 'Preflight failed.',
    });
  });
});
