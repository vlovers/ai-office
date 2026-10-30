import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auditStack,
  PINNED_PATHS,
  REQUIRED_ANCESTORS,
  REQUIRED_JOBS,
  STACK,
} from '../scripts/pr-stack-audit.mjs';

function fixture() {
  const prs = {};
  const runs = {};
  for (const { number, base } of STACK) {
    prs[number] = {
      state: 'open',
      draft: true,
      head: { ref: `branch-${number}`, sha: `head-${number}` },
      base: {
        ref: base === null ? 'main' : `branch-${base}`,
        sha: base === null ? 'main-head' : `head-${base}`,
      },
    };
    runs[number] = [
      {
        id: number,
        name: 'AI Office validation',
        event: 'pull_request',
        head_sha: `head-${number}`,
        status: 'completed',
        conclusion: 'success',
      },
    ];
  }
  const comparisons = Object.fromEntries(
    REQUIRED_ANCESTORS.map((number) => [
      number,
      {
        status: 'ahead',
        behind_by: 0,
        merge_base_commit: { sha: `head-${number}` },
      },
    ]),
  );
  const blobs = Object.fromEntries(
    PINNED_PATHS.map((path) => [path, { source: 'same-blob', candidate: 'same-blob' }]),
  );
  const jobs = REQUIRED_JOBS.map((name) => ({
    name,
    status: 'completed',
    conclusion: 'success',
  }));
  return { mainSha: 'main-head', prs, runs, comparisons, blobs, jobs };
}

function codes(snapshot) {
  return auditStack(snapshot).map((entry) => entry.code);
}

test('accepts pinned Draft chain with exact CI and both candidate jobs', () => {
  assert.deepEqual(auditStack(fixture()), []);
});

test('detects a changed base ref and an advanced base SHA', () => {
  const snapshot = fixture();
  snapshot.prs[107].base.ref = 'main';
  snapshot.prs[103].base.sha = 'unexpected-new-parent';
  assert.equal(codes(snapshot).filter((code) => code === 'base-drift').length, 2);
});

test('detects current main moving beyond root Draft PR bases', () => {
  const snapshot = fixture();
  snapshot.mainSha = 'new-main-head';
  assert.equal(codes(snapshot).filter((code) => code === 'base-drift').length, 2);
});

test('rejects a stale green run and an unverified pending run', () => {
  const snapshot = fixture();
  snapshot.runs[107][0].head_sha = 'old-commit';
  snapshot.runs[108][0].status = 'in_progress';
  snapshot.runs[108][0].conclusion = null;
  assert.ok(codes(snapshot).includes('stale-ci'));
  assert.ok(codes(snapshot).includes('ci-not-green'));
});

test('does not accept a successful run from an unrelated workflow', () => {
  const snapshot = fixture();
  snapshot.runs[116][0].name = 'Unrelated validation';
  assert.ok(codes(snapshot).includes('missing-ci'));
});

test('rejects an incomplete or skipped native security job', () => {
  const snapshot = fixture();
  snapshot.jobs[1].conclusion = 'skipped';
  assert.ok(codes(snapshot).includes('missing-candidate-job'));
  snapshot.jobs.pop();
  assert.ok(codes(snapshot).includes('missing-candidate-job'));
});

test('detects missing merge ancestry even if CI is green', () => {
  const snapshot = fixture();
  snapshot.comparisons[112] = {
    status: 'diverged',
    behind_by: 3,
    merge_base_commit: { sha: 'older-base' },
  };
  assert.ok(codes(snapshot).includes('lost-ancestor'));
});

test('detects a copied security implementation that drifted from PR #109', () => {
  const snapshot = fixture();
  snapshot.blobs[PINNED_PATHS[0]].candidate = 'different-blob';
  assert.ok(codes(snapshot).includes('copied-security-drift'));
});

test('rejects a PR made ready for review without explicit audit update', () => {
  const snapshot = fixture();
  snapshot.prs[116].draft = false;
  assert.ok(codes(snapshot).includes('review-gate'));
});

test('reports missing upstream PR, CI, comparison and security pin evidence', () => {
  const snapshot = fixture();
  delete snapshot.prs[110];
  delete snapshot.runs[95];
  delete snapshot.comparisons[108];
  delete snapshot.blobs[PINNED_PATHS[1]];
  const found = codes(snapshot);
  for (const code of [
    'missing-pr',
    'missing-ci',
    'missing-ancestry',
    'copied-security-drift',
  ]) {
    assert.ok(found.includes(code), `Expected ${code}`);
  }
});
