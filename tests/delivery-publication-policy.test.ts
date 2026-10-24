import { describe, expect, it } from 'vitest';
import { planDeliveryPublication } from '../src/server/delivery-publication-policy.js';
import type { DeliveryPreflight } from '../src/server/delivery-preflight.js';

const workspaceId = '12345678-1234-1234-1234-123456789abc';
const revision = 'a'.repeat(64);
const preflight: DeliveryPreflight = {
  status: 'manual-review',
  revision,
  branch: `ai-office/${workspaceId}`,
  remote: { owner: 'vlovers', repository: 'ai-office' },
  checks: ['task', 'identity', 'kept', 'review', 'remote-format'].map((id) => ({
    id,
    ok: true,
    message: 'Verified.',
  })),
};
const confirmation = {
  revision,
  branch: preflight.branch,
  owner: 'vlovers',
  repository: 'ai-office',
  acknowledged: true as const,
};

describe('delivery publication policy', () => {
  it('produces only a draft plan for an exact reviewed snapshot', () => {
    expect(planDeliveryPublication(preflight, confirmation, 'main')).toEqual({
      allowed: true,
      destination: 'https://github.com/vlovers/ai-office',
      branch: preflight.branch,
      baseBranch: 'main',
      revision,
      draft: true,
    });
  });

  it('rejects a stale review and blocked gates', () => {
    expect(
      planDeliveryPublication(
        { ...preflight, revision: 'b'.repeat(64) },
        confirmation,
        'main',
      ).allowed,
    ).toBe(false);
    expect(
      planDeliveryPublication({ ...preflight, status: 'blocked' }, confirmation, 'main').allowed,
    ).toBe(false);
  });

  it('rejects unsafe branches, unexpected base branches and invalid revisions', () => {
    for (const branch of ['main', 'feature/other', 'ai-office/../../main', 'ai-office/bad']) {
      expect(
        planDeliveryPublication({ ...preflight, branch }, { ...confirmation, branch }, 'main')
          .allowed,
      ).toBe(false);
    }
    expect(planDeliveryPublication(preflight, confirmation, 'production').allowed).toBe(false);
    expect(
      planDeliveryPublication(
        { ...preflight, revision: 'not-a-fingerprint' },
        { ...confirmation, revision: 'not-a-fingerprint' },
        'main',
      ).allowed,
    ).toBe(false);
  });
});
