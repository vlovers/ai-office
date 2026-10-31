import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertStableCIEvidence,
  CANDIDATE_PR,
  auditStack,
  collectStack,
  fetchAttemptJobs,
  fetchWorkflowRuns,
  PINNED_PATHS,
  REQUIRED_ANCESTORS,
  REQUIRED_JOBS,
  requiredStepsForPr,
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
        id: 1000 + number,
        run_attempt: 1,
        pull_requests: [{ number }],
        name: 'AI Office validation',
        event: 'pull_request',
        head_sha: `head-${number}`,
        status: 'completed',
        conclusion: 'success',
      },
    ];
  }
  const comparisons = {
    main: {
      status: 'ahead',
      behind_by: 0,
      merge_base_commit: { sha: 'main-head' },
    },
    edges: Object.fromEntries(
      STACK.map(({ number, base }) => {
        const parentSha = base === null ? 'main-head' : `head-${base}`;
        return [
          number,
          {
            status: 'ahead',
            behind_by: 0,
            base_commit: { sha: parentSha },
            merge_base_commit: { sha: parentSha },
          },
        ];
      }),
    ),
    ...Object.fromEntries(
      REQUIRED_ANCESTORS.map((number) => [
        number,
        {
          status: 'ahead',
          behind_by: 0,
          base_commit: { sha: `head-${number}` },
          merge_base_commit: { sha: `head-${number}` },
        },
      ]),
    ),
  };
  const blobs = Object.fromEntries(
    PINNED_PATHS.map((path) => [path, { source: 'same-blob', candidate: 'same-blob' }]),
  );
  const jobsByPr = Object.fromEntries(
    STACK.map(({ number }) => [
      number,
      REQUIRED_JOBS.map((name, index) => ({
        id: number * 10 + index + 1,
        name,
        run_id: 1000 + number,
        run_attempt: 1,
        status: 'completed',
        conclusion: 'success',
        steps: requiredStepsForPr(number, name).map((stepName, stepIndex) => ({
          name: stepName,
          number: stepIndex + 1,
          status: 'completed',
          conclusion: 'success',
        })),
      })),
    ]),
  );
  const jobs = jobsByPr[CANDIDATE_PR];
  return { mainSha: 'main-head', prs, runs, comparisons, blobs, jobs, jobsByPr };
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

test('rejects current main missing from the integration even if PR base refs advanced', () => {
  const snapshot = fixture();
  snapshot.mainSha = 'new-main-head';
  snapshot.prs[95].base.sha = 'new-main-head';
  snapshot.prs[97].base.sha = 'new-main-head';
  assert.ok(codes(snapshot).includes('main-not-integrated'));
  assert.equal(codes(snapshot).includes('base-drift'), false);
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
  snapshot.runs[CANDIDATE_PR][0].name = 'Unrelated validation';
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
  snapshot.prs[CANDIDATE_PR].draft = false;
  assert.ok(codes(snapshot).includes('review-gate'));
});

test('reports missing upstream PR, CI, comparison and security pin evidence', () => {
  const snapshot = fixture();
  delete snapshot.prs[110];
  delete snapshot.runs[95];
  delete snapshot.comparisons[108];
  delete snapshot.blobs[PINNED_PATHS[1]];
  const found = codes(snapshot);
  for (const code of ['missing-pr', 'missing-ci', 'missing-ancestry', 'copied-security-drift']) {
    assert.ok(found.includes(code), `Expected ${code}`);
  }
});

test('live collector uses only read-only GitHub API calls and exact source refs', async () => {
  const source = fixture();
  const requested = [];
  const request = async (url, options) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    requested.push(path);
    assert.equal(options.method ?? 'GET', 'GET');
    assert.equal(options.headers.Authorization, 'Bearer fixture-token');
    let body;
    if (path.endsWith('/branches/main')) {
      body = { commit: { sha: source.mainSha } };
    } else if (/\/pulls\/(\d+)$/.test(path)) {
      body = source.prs[Number(path.match(/\/pulls\/(\d+)$/)[1])];
    } else if (path.endsWith('/actions/runs')) {
      const number = Number(parsed.searchParams.get('head_sha').slice('head-'.length));
      body = { total_count: source.runs[number].length, workflow_runs: source.runs[number] };
    } else if (/\/actions\/runs\/\d+\/attempts\/\d+\/jobs$/.test(path)) {
      const number = Number(path.match(/\/actions\/runs\/(\d+)\/attempts/)[1]) - 1000;
      body = { total_count: source.jobsByPr[number].length, jobs: source.jobsByPr[number] };
    } else if (path.includes('/compare/')) {
      const base = path.split('/compare/')[1].split('...')[0];
      const number = Number(base.slice('head-'.length));
      const target = Number(path.split('...')[1].slice('head-'.length));
      body =
        base === source.mainSha && target === CANDIDATE_PR
          ? source.comparisons.main
          : REQUIRED_ANCESTORS.includes(number) && target === CANDIDATE_PR
            ? source.comparisons[number]
            : source.comparisons.edges[target];
    } else if (path.includes('/contents/')) {
      const file = decodeURIComponent(path.split('/contents/')[1]);
      const ref = parsed.searchParams.get('ref');
      body = {
        sha:
          ref === source.prs[109].head.sha
            ? source.blobs[file].source
            : source.blobs[file].candidate,
      };
    } else {
      throw new Error('Unexpected GitHub endpoint: ' + path);
    }
    return { ok: true, json: async () => body };
  };
  const actual = await collectStack({ request, token: 'fixture-token' });
  assert.deepEqual(auditStack(actual), []);
  assert.ok(requested.some((path) => path.includes(`/compare/main-head...head-${CANDIDATE_PR}`)));
  assert.ok(requested.some((path) => path.includes('/compare/head-135...head-136')));
  assert.ok(requested.some((path) => path.includes(`/compare/head-116...head-${CANDIDATE_PR}`)));
  assert.ok(requested.some((path) => path.includes('/compare/head-96...head-107')));
  assert.ok(requested.some((path) => path.includes('/compare/head-103...head-110')));
  assert.ok(requested.every((path) => path.startsWith('/repos/vlovers/ai-office/')));
  assert.equal(requested.filter((path) => path.endsWith('/actions/runs')).length, STACK.length * 2);
  assert.equal(
    requested.filter((path) => /\/attempts\/\d+\/jobs$/.test(path)).length,
    STACK.length * 2,
  );
});

test('newer failed CI overrides older green CI regardless of API array order', () => {
  const snapshot = fixture();
  const oldRun = snapshot.runs[107][0];
  snapshot.runs[107] = [oldRun, { ...oldRun, id: oldRun.id + 10000, conclusion: 'failure' }];
  assert.ok(codes(snapshot).includes('ci-not-green'));
});

test('a successful workflow for another PR on the same SHA is not evidence', () => {
  const snapshot = fixture();
  snapshot.runs[107][0].pull_requests = [{ number: 999 }];
  assert.ok(codes(snapshot).includes('missing-ci'));
});

test('candidate jobs must belong to the latest run and attempt', () => {
  const snapshot = fixture();
  snapshot.jobs[0].run_id = 1115;
  snapshot.jobs[1].run_attempt = 2;
  assert.equal(codes(snapshot).filter((code) => code === 'missing-candidate-job').length, 2);
});

test('duplicate jobs cannot conceal a failed security job', () => {
  const snapshot = fixture();
  snapshot.jobs.push({
    ...snapshot.jobs[1],
    conclusion: 'failure',
  });
  assert.ok(codes(snapshot).includes('missing-candidate-job'));
});

test('collector retrieves every page for the exact CI attempt', async () => {
  const paths = [];
  const get = async (path) => {
    paths.push(path);
    const page = Number(new URL('https://api.github.com' + path).searchParams.get('page'));
    return {
      total_count: 101,
      jobs: Array.from({ length: page === 1 ? 100 : 1 }, (_, index) => ({
        id: (page - 1) * 100 + index + 1,
      })),
    };
  };
  const jobs = await fetchAttemptJobs(get, '/repos/vlovers/ai-office', {
    id: 500,
    run_attempt: 3,
  });
  assert.equal(jobs.length, 101);
  assert.equal(paths.length, 2);
  assert.ok(paths.every((path) => path.includes('/runs/500/attempts/3/jobs?')));
});

test('collector fails closed when GitHub truncates candidate job evidence', async () => {
  await assert.rejects(
    fetchAttemptJobs(async () => ({ total_count: 101, jobs: [] }), '/repos/vlovers/ai-office', {
      id: 500,
      run_attempt: 3,
    }),
    /inconsistent/,
  );
});

test('run pagination includes a failed newer run hidden beyond the first page', async () => {
  const paths = [];
  const source = fixture().runs[107][0];
  const get = async (path) => {
    paths.push(path);
    const page = Number(new URL('https://api.github.com' + path).searchParams.get('page'));
    return {
      total_count: 101,
      workflow_runs:
        page === 1
          ? Array.from({ length: 100 }, (_, index) => ({ ...source, id: 2000 + index }))
          : [{ ...source, id: 9000, conclusion: 'failure' }],
    };
  };
  const runs = await fetchWorkflowRuns(get, '/repos/vlovers/ai-office', 'head-107');
  const snapshot = fixture();
  snapshot.runs[107] = runs;
  assert.equal(runs.length, 101);
  assert.equal(paths.length, 2);
  assert.ok(codes(snapshot).includes('ci-not-green'));
});

test('run pagination rejects an incomplete first page instead of trusting old green', async () => {
  await assert.rejects(
    fetchWorkflowRuns(
      async () => ({ total_count: 101, workflow_runs: [{ id: 1, head_sha: 'head-107' }] }),
      '/repos/vlovers/ai-office',
      'head-107',
    ),
    /inconsistent/,
  );
});

test('run pagination rejects repeated IDs across pages', async () => {
  const get = async (path) => {
    const page = Number(new URL('https://api.github.com' + path).searchParams.get('page'));
    return {
      total_count: 101,
      workflow_runs:
        page === 1
          ? Array.from({ length: 100 }, (_, index) => ({
              id: index + 1,
              head_sha: 'head-107',
            }))
          : [{ id: 100, head_sha: 'head-107' }],
    };
  };
  await assert.rejects(
    fetchWorkflowRuns(get, '/repos/vlovers/ai-office', 'head-107'),
    /duplicate IDs/,
  );
});

test('run pagination rejects changing total_count between pages', async () => {
  const get = async (path) => {
    const page = Number(new URL('https://api.github.com' + path).searchParams.get('page'));
    return {
      total_count: page === 1 ? 101 : 102,
      workflow_runs:
        page === 1
          ? Array.from({ length: 100 }, (_, index) => ({
              id: index + 1,
              head_sha: 'head-107',
            }))
          : [{ id: 101, head_sha: 'head-107' }],
    };
  };
  await assert.rejects(
    fetchWorkflowRuns(get, '/repos/vlovers/ai-office', 'head-107'),
    /inconsistent total_count/,
  );
});

test('run search rejects records for a different commit', async () => {
  await assert.rejects(
    fetchWorkflowRuns(
      async () => ({
        total_count: 1,
        workflow_runs: [{ id: 1, head_sha: 'unrelated-commit' }],
      }),
      '/repos/vlovers/ai-office',
      'head-107',
    ),
    /different commit/,
  );
});

test('candidate job pagination rejects duplicate IDs across pages', async () => {
  const get = async (path) => {
    const page = Number(new URL('https://api.github.com' + path).searchParams.get('page'));
    return {
      total_count: 101,
      jobs:
        page === 1 ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1 })) : [{ id: 100 }],
    };
  };
  await assert.rejects(
    fetchAttemptJobs(get, '/repos/vlovers/ai-office', { id: 500, run_attempt: 1 }),
    /duplicate IDs/,
  );
});

test('green CI without a verifiable attempt is not accepted', () => {
  const snapshot = fixture();
  snapshot.runs[107][0].run_attempt = null;
  assert.ok(codes(snapshot).includes('ci-evidence-invalid'));
});

test('GitHub API failure cannot be reported as a successful audit', async () => {
  await assert.rejects(
    collectStack({
      request: async () => ({ ok: false, status: 503 }),
      token: 'fixture-token',
    }),
    /GitHub read failed \(503\)/,
  );
});

test('rejects a force-pushed child that no longer contains its declared parent', () => {
  const snapshot = fixture();
  // The GitHub PR metadata still points to the expected parent HEAD.
  snapshot.comparisons.edges[107] = {
    status: 'diverged',
    behind_by: 1,
    base_commit: { sha: 'head-96' },
    merge_base_commit: { sha: 'older-ancestor' },
  };
  assert.equal(codes(snapshot).includes('base-drift'), false);
  assert.ok(codes(snapshot).includes('lost-stack-parent'));
});

test('rejects root branches that omit current main even when base metadata matches', () => {
  const snapshot = fixture();
  snapshot.comparisons.edges[97].merge_base_commit.sha = 'old-main';
  assert.ok(codes(snapshot).includes('lost-stack-parent'));
});

test('rejects missing or forged edge ancestry evidence', () => {
  const snapshot = fixture();
  delete snapshot.comparisons.edges[103];
  snapshot.comparisons.edges[96].base_commit.sha = 'unrelated-commit';
  const found = codes(snapshot);
  assert.ok(found.includes('missing-edge-evidence'));
  assert.ok(found.includes('lost-stack-parent'));
});

test('collector rejects a main push while evidence is being collected', async () => {
  const source = fixture();
  let mainReads = 0;
  const request = async (url) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (path.endsWith('/branches/main')) {
      mainReads += 1;
      return {
        ok: true,
        json: async () => ({ commit: { sha: mainReads === 1 ? source.mainSha : 'moved-main' } }),
      };
    }
    if (/\/pulls\/(\d+)$/.test(path)) {
      const number = Number(path.match(/\/pulls\/(\d+)$/)[1]);
      return { ok: true, json: async () => source.prs[number] };
    }
    if (path.endsWith('/actions/runs')) {
      const number = Number(parsed.searchParams.get('head_sha').slice('head-'.length));
      return {
        ok: true,
        json: async () => ({
          total_count: source.runs[number].length,
          workflow_runs: source.runs[number],
        }),
      };
    }
    if (/\/actions\/runs\/\d+\/attempts\/\d+\/jobs$/.test(path)) {
      const number = Number(path.match(/\/actions\/runs\/(\d+)\/attempts/)[1]) - 1000;
      return {
        ok: true,
        json: async () => ({
          total_count: source.jobsByPr[number].length,
          jobs: source.jobsByPr[number],
        }),
      };
    }
    if (path.includes('/compare/')) {
      const [base, head] = path.split('/compare/')[1].split('...');
      const number = Number(base.slice('head-'.length));
      const target = Number(head.slice('head-'.length));
      const body =
        base === source.mainSha && target === CANDIDATE_PR
          ? source.comparisons.main
          : REQUIRED_ANCESTORS.includes(number) && target === CANDIDATE_PR
            ? source.comparisons[number]
            : source.comparisons.edges[target];
      return { ok: true, json: async () => body };
    }
    if (path.includes('/contents/')) {
      const file = decodeURIComponent(path.split('/contents/')[1]);
      const ref = parsed.searchParams.get('ref');
      return {
        ok: true,
        json: async () => ({
          sha:
            ref === source.prs[109].head.sha
              ? source.blobs[file].source
              : source.blobs[file].candidate,
        }),
      };
    }
    throw new Error('Unexpected endpoint: ' + path);
  };
  await assert.rejects(
    collectStack({ request, token: 'fixture-token' }),
    /main HEAD changed during stack audit/,
  );
  assert.equal(mainReads, 2);
});

test('CI recheck rejects a new failed run after the initial green snapshot', () => {
  const snapshot = fixture();
  const refreshed = structuredClone(snapshot.runs);
  const original = refreshed[107][0];
  refreshed[107].push({ ...original, id: original.id + 10000, conclusion: 'failure' });
  assert.throws(
    () => assertStableCIEvidence(snapshot.runs, refreshed, snapshot.jobs, snapshot.jobs),
    /PR #107 CI changed during stack audit/,
  );
});

test('CI recheck rejects a rerun of the same run ID with a new attempt', () => {
  const snapshot = fixture();
  const refreshed = structuredClone(snapshot.runs);
  refreshed[CANDIDATE_PR][0].run_attempt = 2;
  assert.throws(
    () => assertStableCIEvidence(snapshot.runs, refreshed, snapshot.jobs, snapshot.jobs),
    new RegExp(`PR #${CANDIDATE_PR} CI changed during stack audit`),
  );
});

test('CI recheck rejects a native security job that fails after the first read', () => {
  const snapshot = fixture();
  const refreshedJobs = structuredClone(snapshot.jobs);
  refreshedJobs[1].conclusion = 'failure';
  assert.throws(
    () => assertStableCIEvidence(snapshot.runs, snapshot.runs, snapshot.jobs, refreshedJobs),
    /candidate CI jobs changed during stack audit/,
  );
});

test('CI recheck ignores API ordering changes without losing run or job evidence', () => {
  const snapshot = fixture();
  const refreshed = structuredClone(snapshot.runs);
  refreshed[107].push({ ...refreshed[107][0], id: 5000 });
  snapshot.runs[107].push({ ...snapshot.runs[107][0], id: 5000 });
  assert.doesNotThrow(() =>
    assertStableCIEvidence(
      snapshot.runs,
      { ...refreshed, 107: refreshed[107].reverse() },
      snapshot.jobs,
      [...snapshot.jobs].reverse(),
    ),
  );
});

test('audits post-integration Draft PRs including the divergent CI-policy sibling', () => {
  assert.deepEqual(STACK.slice(-14), [
    { number: 123, base: 122 },
    { number: 124, base: 122 },
    { number: 125, base: 123 },
    { number: 126, base: 125 },
    { number: 127, base: 126 },
    { number: 128, base: 127 },
    { number: 129, base: 128 },
    { number: 130, base: 129 },
    { number: 131, base: 130 },
    { number: 132, base: 131 },
    { number: 133, base: 132 },
    { number: 134, base: 133 },
    { number: 135, base: 134 },
    { number: 136, base: 135 },
  ]);
  assert.equal(CANDIDATE_PR, 136);
  assert.equal(REQUIRED_ANCESTORS.includes(124), false);
  assert.deepEqual(auditStack(fixture()), []);
});

test('rejects failed native-security tip even when historical integration CI is green', () => {
  const snapshot = fixture();
  snapshot.runs[CANDIDATE_PR][0].conclusion = 'failure';
  assert.equal(snapshot.runs[116][0].conclusion, 'success');
  assert.ok(codes(snapshot).includes('ci-not-green'));
});

test('rejects security tip losing its parent despite a green CI run', () => {
  const snapshot = fixture();
  snapshot.comparisons.edges[CANDIDATE_PR].behind_by = 1;
  snapshot.comparisons.edges[CANDIDATE_PR].merge_base_commit.sha = 'old-133';
  assert.ok(codes(snapshot).includes('lost-stack-parent'));
});

test('requires latest security tip to contain the original integration join', () => {
  const snapshot = fixture();
  snapshot.comparisons[116].behind_by = 2;
  assert.ok(codes(snapshot).includes('lost-ancestor'));
});

test('requires Linux and native macOS jobs from latest security tip, not #116', () => {
  const snapshot = fixture();
  snapshot.jobs[0].run_id = snapshot.runs[116][0].id;
  snapshot.jobs[1].run_id = snapshot.runs[116][0].id;
  assert.equal(codes(snapshot).filter((code) => code === 'missing-candidate-job').length, 2);
});

test('fails closed when latest security PR disappears from the stack snapshot', () => {
  const snapshot = fixture();
  delete snapshot.prs[CANDIDATE_PR];
  assert.ok(codes(snapshot).includes('missing-pr'));
  assert.ok(codes(snapshot).includes('main-not-integrated'));
});

// A sibling with a separate Git history still requires its own exact CI
// evidence; it must not be falsely asserted as an ancestor of the tip.
test('requires independent CI evidence for divergent PR #124', () => {
  const snapshot = fixture();
  delete snapshot.runs[124];
  assert.ok(codes(snapshot).includes('missing-ci'));
  assert.equal(REQUIRED_ANCESTORS.includes(124), false);
});

test('rejects missing PR #123 ancestry even when sibling #124 is green', () => {
  const snapshot = fixture();
  snapshot.comparisons[123].behind_by = 1;
  snapshot.comparisons[123].merge_base_commit.sha = 'old-123';
  assert.equal(snapshot.runs[124][0].conclusion, 'success');
  assert.ok(codes(snapshot).includes('lost-ancestor'));
});

test('rejects intermediate security PR losing its declared parent', () => {
  const snapshot = fixture();
  snapshot.comparisons.edges[129].behind_by = 1;
  snapshot.comparisons.edges[129].merge_base_commit.sha = 'old-128';
  assert.equal(snapshot.runs[CANDIDATE_PR][0].conclusion, 'success');
  assert.ok(codes(snapshot).includes('lost-stack-parent'));
});

test('rejects failed intermediate security CI despite green integration tip', () => {
  const snapshot = fixture();
  snapshot.runs[130][0].conclusion = 'failure';
  assert.equal(snapshot.runs[CANDIDATE_PR][0].conclusion, 'success');
  assert.ok(codes(snapshot).includes('ci-not-green'));
});

test('CI recheck includes newly monitored post-122 security PRs', () => {
  const snapshot = fixture();
  const refreshed = structuredClone(snapshot.runs);
  refreshed[132][0].conclusion = 'failure';
  assert.throws(
    () => assertStableCIEvidence(snapshot.runs, refreshed, snapshot.jobs, snapshot.jobs),
    /PR #132 CI changed during stack audit/,
  );
});

test('rejects a skipped upstream macOS job despite a successful workflow conclusion', () => {
  const snapshot = fixture();
  snapshot.jobsByPr[124][1].conclusion = 'skipped';
  assert.equal(snapshot.runs[124][0].conclusion, 'success');
  assert.ok(codes(snapshot).includes('missing-upstream-job'));
});

test('rejects missing or duplicated upstream security jobs', () => {
  const snapshot = fixture();
  snapshot.jobsByPr[107].pop();
  snapshot.jobsByPr[124].push({ ...snapshot.jobsByPr[124][1], id: 99999 });
  assert.equal(codes(snapshot).filter((code) => code === 'missing-upstream-job').length, 2);
});

test('rejects upstream jobs belonging to a different run or attempt', () => {
  const snapshot = fixture();
  snapshot.jobsByPr[95][0].run_id += 1;
  snapshot.jobsByPr[97][1].run_attempt += 1;
  assert.equal(codes(snapshot).filter((code) => code === 'missing-upstream-job').length, 2);
});

test('missing upstream job evidence is not silently accepted as green', () => {
  const snapshot = fixture();
  delete snapshot.jobsByPr[124];
  assert.equal(codes(snapshot).filter((code) => code === 'missing-upstream-job').length, 2);
});

test('upstream job mutation during collection invalidates the audit', () => {
  const snapshot = fixture();
  const refreshed = structuredClone(snapshot.jobsByPr);
  refreshed[124][1].conclusion = 'failure';
  assert.throws(
    () =>
      assertStableCIEvidence(
        snapshot.runs,
        snapshot.runs,
        snapshot.jobs,
        snapshot.jobs,
        snapshot.jobsByPr,
        refreshed,
      ),
    /PR #124 CI jobs changed during stack audit/,
  );
});

test('rejects a skipped native sandbox step despite a successful macOS job', () => {
  const snapshot = fixture();
  const native = snapshot.jobsByPr[124][1];
  native.steps.find(
    (step) => step.name === 'Native read-only and isolated-write policy',
  ).conclusion = 'skipped';
  assert.equal(native.conclusion, 'success');
  assert.ok(codes(snapshot).includes('missing-ci-step'));
});

test('rejects missing and duplicated candidate security steps', () => {
  const snapshot = fixture();
  const steps = snapshot.jobs[0].steps;
  const target = steps.find((step) => step.name === 'TypeScript');
  steps.push({ ...target, number: 99 });
  assert.ok(codes(snapshot).includes('missing-ci-step'));

  const missing = fixture();
  missing.jobs[1].steps = missing.jobs[1].steps.filter(
    (step) => step.name !== 'Native read-only and isolated-write policy',
  );
  assert.ok(codes(missing).includes('missing-ci-step'));
});

test('rejects security gates executed out of order', () => {
  const snapshot = fixture();
  const steps = snapshot.jobsByPr[107][0].steps;
  const typecheck = steps.find((step) => step.name === 'TypeScript');
  const lint = steps.find((step) => step.name === 'Delivery security lint');
  [typecheck.number, lint.number] = [lint.number, typecheck.number];
  assert.ok(codes(snapshot).includes('missing-ci-step'));
});

test('requires the offline policy regressions from PR #124 onward', () => {
  const snapshot = fixture();
  snapshot.jobsByPr[124][0].steps = snapshot.jobsByPr[124][0].steps.filter(
    (step) => step.name !== 'CI trigger and security policy regressions',
  );
  assert.ok(codes(snapshot).includes('missing-ci-step'));
  assert.equal(
    requiredStepsForPr(123, REQUIRED_JOBS[0]).includes(
      'CI trigger and security policy regressions',
    ),
    false,
  );
  assert.equal(
    requiredStepsForPr(124, REQUIRED_JOBS[0]).includes(
      'CI trigger and security policy regressions',
    ),
    true,
  );
});

test('CI recheck detects an upstream step changing after a green snapshot', () => {
  const snapshot = fixture();
  const refreshed = structuredClone(snapshot.jobsByPr);
  refreshed[124][1].steps[3].conclusion = 'skipped';
  assert.throws(
    () =>
      assertStableCIEvidence(
        snapshot.runs,
        snapshot.runs,
        snapshot.jobs,
        snapshot.jobs,
        snapshot.jobsByPr,
        refreshed,
      ),
    /PR #124 CI jobs changed during stack audit/,
  );
});

test('CI recheck detects a candidate step changing without changing job conclusion', () => {
  const snapshot = fixture();
  const refreshed = structuredClone(snapshot.jobs);
  refreshed[0].steps[3].conclusion = 'failure';
  assert.throws(
    () => assertStableCIEvidence(snapshot.runs, snapshot.runs, snapshot.jobs, refreshed),
    /candidate CI jobs changed during stack audit/,
  );
});
