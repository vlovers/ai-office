import { describe, expect, it } from 'vitest';
import { reconcilePublicationCandidates } from '../src/server/delivery-publication-reconciliation.js';

const plan = {
  allowed: true as const,
  destination: 'https://github.com/vlovers/ai-office',
  branch: 'ai-office/12345678-1234-1234-1234-123456789abc',
  baseBranch: 'main',
  revision: 'a'.repeat(64),
  draft: true as const,
};
const repo = { full_name: 'vlovers/ai-office' };
const candidate = {
  html_url: 'https://github.com/vlovers/ai-office/pull/123',
  draft: true,
  state: 'open',
  head: { ref: plan.branch, repo },
  base: { ref: 'main', repo },
};

describe('uncertain publication reconciliation', () => {
  it('confirms exactly one matching open draft PR', () => {
    expect(reconcilePublicationCandidates(plan, [candidate])).toEqual({
      status: 'confirmed',
      pullRequestUrl: candidate.html_url,
    });
  });

  it('never treats absence as permission to retry', () => {
    expect(reconcilePublicationCandidates(plan, []).status).toBe('unresolved');
  });

  it('refuses multiple matching PRs', () => {
    expect(
      reconcilePublicationCandidates(plan, [
        candidate,
        { ...candidate, html_url: 'https://github.com/vlovers/ai-office/pull/124' },
      ]).status,
    ).toBe('unresolved');
  });

  it('rejects one valid receipt when a second PR reuses the managed head', () => {
    for (const conflict of [
      {
        ...candidate,
        html_url: 'https://github.com/vlovers/ai-office/pull/124',
        base: { ref: 'release', repo },
      },
      {
        ...candidate,
        html_url: 'https://github.com/vlovers/ai-office/pull/125',
        state: 'closed',
        base: { ref: 'release', repo },
      },
      {
        ...candidate,
        html_url: 'https://github.com/vlovers/ai-office/pull/126',
        head: { ref: plan.branch, repo: { full_name: 'other/fork' } },
      },
    ]) {
      const result = reconcilePublicationCandidates(plan, [candidate, conflict]);
      expect(result.status).toBe('unresolved');
    }
  });

  it('still confirms a unique receipt alongside unrelated branches', () => {
    const unrelated = {
      ...candidate,
      html_url: 'https://github.com/vlovers/ai-office/pull/124',
      head: { ref: 'feature/unrelated', repo },
    };
    expect(reconcilePublicationCandidates(plan, [candidate, unrelated])).toEqual({
      status: 'confirmed',
      pullRequestUrl: candidate.html_url,
    });
  });

  it('refuses closed, non-draft, forked or foreign PRs', () => {
    for (const mismatch of [
      { ...candidate, state: 'closed' },
      { ...candidate, draft: false },
      { ...candidate, head: { ref: plan.branch, repo: { full_name: 'evil/fork' } } },
      { ...candidate, html_url: 'https://github.com/other/repo/pull/123' },
    ]) {
      expect(reconcilePublicationCandidates(plan, [mismatch]).status).toBe('unresolved');
    }
  });

  it('ignores unrelated branch candidates without confirming them', () => {
    expect(
      reconcilePublicationCandidates(plan, [{ ...candidate, head: { ref: 'unrelated', repo } }])
        .status,
    ).toBe('unresolved');
  });
});
