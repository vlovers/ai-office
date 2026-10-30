import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auditStack,
  collectStack,
  fetchAttemptJobs,
  fetchWorkflowRuns,
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
          merge_base_commit: { sha: `head-${number}` },
        },
      ]),
    ),
  };
  const blobs = Object.fromEntries(
    PINNED_PATHS.map((path) => [path, { source: 'same-blob', candidate: 'same-blob' }]),
  );
  const jobs = REQUIRED_JOBS.map((name, index) => ({
    id: index + 1,
    name,
    run_id: 1116,
    run_attempt: 1,
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
      body = { total_count: source.jobs.length, jobs: source.jobs };
    } else if (path.includes('/compare/')) {
      const base = path.split('/compare/')[1].split('...')[0];
      const number = Number(base.slice('head-'.length));
      const target = Number(path.split('...')[1].slice('head-'.length));
      body =
        base === source.mainSha && target === 116
          ? source.comparisons.main
          : REQUIRED_ANCESTORS.includes(number) && target === 116
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
  assert.ok(requested.some((path) => path.includes('/compare/main-head...head-116')));
  assert.ok(requested.some((path) => path.includes('/compare/head-96...head-107')));
  assert.ok(requested.some((path) => path.includes('/compare/head-103...head-110')));
  assert.ok(requested.every((path) => path.startsWith('/repos/vlovers/ai-office/')));
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
      return {
        ok: true,
        json: async () => ({ total_count: source.jobs.length, jobs: source.jobs }),
      };
    }
    if (path.includes('/compare/')) {
      const [base, head] = path.split('/compare/')[1].split('...');
      const number = Number(base.slice('head-'.length));
      const target = Number(head.slice('head-'.length));
      const body =
        base === source.mainSha && target === 116
          ? source.comparisons.main
          : REQUIRED_ANCESTORS.includes(number) && target === 116
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
