import { describe, expect, it } from 'vitest';
import { validateDeliveryConfirmation } from '../src/server/delivery-confirmation.js';
import type { DeliveryPreflight } from '../src/server/delivery-preflight.js';

const preflight: DeliveryPreflight = {
  status: 'manual-review',
  revision: 'revision-123',
  branch: 'office/workspace-1',
  remote: { owner: 'vlovers', repository: 'ai-office' },
  checks: [{ id: 'review', ok: true, message: 'Review current.' }],
};
const confirmation = {
  revision: 'revision-123',
  branch: 'office/workspace-1',
  owner: 'vlovers',
  repository: 'ai-office',
  acknowledged: true as const,
};

describe('delivery confirmation contract', () => {
  it('matches an explicit acknowledgement to the exact preflight snapshot', () => {
    expect(validateDeliveryConfirmation(preflight, confirmation)).toEqual({
      valid: true,
      destination: 'https://github.com/vlovers/ai-office',
    });
  });

  it('fails closed on a stale revision, changed branch or different remote', () => {
    for (const patch of [
      { revision: 'old' },
      { branch: 'main' },
      { owner: 'someone-else' },
      { repository: 'different' },
    ]) {
      expect(validateDeliveryConfirmation(preflight, { ...confirmation, ...patch }).valid).toBe(
        false,
      );
    }
  });

  it('rejects missing acknowledgement and blocked or inconsistent preflight', () => {
    expect(
      validateDeliveryConfirmation(preflight, { ...confirmation, acknowledged: false } as never)
        .valid,
    ).toBe(false);
    expect(
      validateDeliveryConfirmation({ ...preflight, status: 'blocked' }, confirmation).valid,
    ).toBe(false);
    expect(
      validateDeliveryConfirmation(
        { ...preflight, checks: [{ id: 'review', ok: false, message: 'Stale.' }] },
        confirmation,
      ).valid,
    ).toBe(false);
    expect(
      validateDeliveryConfirmation({ ...preflight, checks: [] }, confirmation).valid,
    ).toBe(false);
    expect(
      validateDeliveryConfirmation({ ...preflight, revision: null }, confirmation).valid,
    ).toBe(false);
    expect(
      validateDeliveryConfirmation({ ...preflight, remote: null }, confirmation).valid,
    ).toBe(false);
  });
});
