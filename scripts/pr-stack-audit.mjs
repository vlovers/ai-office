import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// These are review dependencies, not permission to merge any of the branches.
export const STACK = [
  { number: 95, base: null },
  { number: 96, base: 95 },
  { number: 97, base: null },
  { number: 103, base: 97 },
  { number: 107, base: 96 },
  { number: 108, base: 107 },
  { number: 109, base: 103 },
  { number: 110, base: 103 },
  { number: 111, base: 95 },
  { number: 112, base: 111 },
  { number: 113, base: 108 },
  { number: 116, base: 113 },
  { number: 117, base: 116 },
  { number: 118, base: 117 },
  { number: 119, base: 118 },
  { number: 120, base: 119 },
  { number: 121, base: 120 },
  { number: 122, base: 121 },
  { number: 123, base: 122 },
  // #124 is a sibling of #123. #125 reconciles its policy checks but does
  // not contain its Git commits: audit #124 without claiming it as an ancestor.
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
  { number: 137, base: 136 },
];

// The latest reviewed integration tip, not the older browser/server join PR.
export const CANDIDATE_PR = 137;

export const REQUIRED_ANCESTORS = [
  108, 110, 112, 116, 121, 122, 123, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136,
];
export const PINNED_PATHS = ['src/server/qa-runner.ts', 'tests/qa-plan-preflight-race.test.ts'];
export const POLICY_REGRESSION_PATH = 'tests/ci-trigger-policy.node.mjs';
export const REQUIRED_JOBS = [
  'TypeScript, tests, smoke, build and formatting',
  'Native Codex filesystem policy (no inference)',
];

/**
 * A successful job does not prove that security-critical steps ran. Keep the
 * common contract valid for historical PRs, then require the additional
 * offline policy gates from the first PR (#124) that introduced them.
 */
export const REQUIRED_STEPS = {
  [REQUIRED_JOBS[0]]: [
    'Checkout',
    'Set up Node.js',
    'Install dependencies',
    'TypeScript',
    'Delivery security lint',
    'Unit and integration tests',
    'HTTP/SSE smoke tests',
    'Production build',
    'Formatting',
    'Install Chromium and browser dependencies',
    'Browser smoke (deterministic fixtures)',
    'Office V4 scene and state browser smoke (no model calls)',
    'Isolated write browser smoke (no model calls)',
    'Agent Studio browser and restart smoke (no model calls)',
  ],
  [REQUIRED_JOBS[1]]: [
    'Checkout',
    'Set up Node.js',
    'Install dependencies',
    'Native read-only and isolated-write policy',
    'Reviewer, QA, workflow recovery and security integration (native sandbox, no inference)',
    'Build production dashboard',
    'Install Chromium',
    'Coder to Reviewer to QA browser approval journey (native sandbox, no inference)',
  ],
};
export const POLICY_STEPS = [
  'Offline integration stack audit regressions',
  'CI trigger and security policy regressions',
];

export function requiredStepsForPr(number, jobName) {
  const common = REQUIRED_STEPS[jobName] ?? [];
  if (number < 124 || jobName !== REQUIRED_JOBS[0]) return common;
  return [...common.slice(0, 6), ...POLICY_STEPS, ...common.slice(6)];
}

const VALIDATION_WORKFLOW = 'AI Office validation';

// The same commit may have checks from different PRs. Only a run attached to
// this exact PR is evidence, and a newer failure must override an older green.
export function selectValidationRun(runs, number) {
  return (runs ?? [])
    .filter(
      (run) =>
        run.name === VALIDATION_WORKFLOW &&
        run.event === 'pull_request' &&
        run.pull_requests?.some((pr) => pr.number === number),
    )
    .sort(
      (left, right) => right.id - left.id || (right.run_attempt ?? 0) - (left.run_attempt ?? 0),
    )[0];
}

// GitHub's first page is not complete evidence. A truncated page, changing
// total_count or duplicate record ID must never be interpreted as green CI.
export async function fetchPagedEvidence(get, path, field, label) {
  const records = [];
  const ids = new Set();
  let total = null;
  for (let page = 1; page <= 10; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const result = await get(`${path}${separator}per_page=100&page=${page}`);
    const entries = result?.[field];
    if (
      !Number.isSafeInteger(result?.total_count) ||
      result.total_count < 0 ||
      !Array.isArray(entries) ||
      entries.length > 100
    ) {
      throw new Error(`GitHub returned incomplete ${label} evidence`);
    }
    if (total === null) total = result.total_count;
    if (result.total_count !== total) {
      throw new Error(`GitHub ${label} pages have inconsistent total_count`);
    }
    for (const entry of entries) {
      if (!Number.isSafeInteger(entry?.id) || entry.id <= 0 || ids.has(entry.id)) {
        throw new Error(`GitHub ${label} pages contain invalid or duplicate IDs`);
      }
      ids.add(entry.id);
      records.push(entry);
    }
    if (records.length === total) return records;
    if (records.length > total || entries.length !== 100) {
      throw new Error(`GitHub ${label} pages are inconsistent`);
    }
  }
  throw new Error(`GitHub ${label} evidence exceeds pagination limit`);
}

export async function fetchWorkflowRuns(get, root, headSha) {
  if (typeof headSha !== 'string' || !headSha) throw new Error('Missing PR head SHA');
  const runs = await fetchPagedEvidence(
    get,
    `${root}/actions/runs?head_sha=${encodeURIComponent(headSha)}&event=pull_request`,
    'workflow_runs',
    'workflow run',
  );
  if (runs.some((run) => run.head_sha !== headSha)) {
    throw new Error('GitHub returned workflow run for a different commit');
  }
  return runs;
}

// Read the jobs for the exact attempt; never silently trust a truncated page.
export async function fetchAttemptJobs(get, root, run) {
  if (!Number.isSafeInteger(run?.id) || !Number.isSafeInteger(run?.run_attempt)) {
    throw new Error('Candidate CI run has no verifiable ID and attempt');
  }
  return fetchPagedEvidence(
    get,
    `${root}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,
    'jobs',
    'candidate job',
  );
}

// GitHub Actions can start a new run or rerun the same ID while the audit
// reads unrelated PRs. Recheck relevant CI fields before trusting a snapshot.
export function assertStableCIEvidence(
  initialRuns,
  refreshedRuns,
  initialJobs,
  refreshedJobs,
  initialJobsByPr = {},
  refreshedJobsByPr = {},
) {
  const runFingerprint = (entries) =>
    JSON.stringify(
      (entries ?? [])
        .map((run) => ({
          id: run.id,
          run_attempt: run.run_attempt,
          name: run.name,
          event: run.event,
          head_sha: run.head_sha,
          status: run.status,
          conclusion: run.conclusion,
          pull_requests: (run.pull_requests ?? []).map((pr) => pr.number).sort((a, b) => a - b),
        }))
        .sort((a, b) => a.id - b.id),
    );
  const jobFingerprint = (entries) =>
    JSON.stringify(
      (entries ?? [])
        .map((job) => ({
          id: job.id,
          name: job.name,
          run_id: job.run_id,
          run_attempt: job.run_attempt,
          status: job.status,
          conclusion: job.conclusion,
          steps: (job.steps ?? [])
            .map((step) => ({
              name: step.name,
              number: step.number,
              status: step.status,
              conclusion: step.conclusion,
            }))
            .sort((a, b) => a.number - b.number),
        }))
        .sort((a, b) => a.id - b.id),
    );

  for (const { number } of STACK) {
    if (runFingerprint(initialRuns[number]) !== runFingerprint(refreshedRuns[number])) {
      throw new Error(`GitHub PR #${number} CI changed during stack audit`);
    }
  }
  if (jobFingerprint(initialJobs) !== jobFingerprint(refreshedJobs)) {
    throw new Error('GitHub candidate CI jobs changed during stack audit');
  }
  for (const { number } of STACK) {
    if (number === CANDIDATE_PR) continue;
    if (jobFingerprint(initialJobsByPr[number]) !== jobFingerprint(refreshedJobsByPr[number])) {
      throw new Error(`GitHub PR #${number} CI jobs changed during stack audit`);
    }
  }
}

// Pure, deterministic evaluation: tests never need a token or network access.
export function auditStack(snapshot) {
  const issues = [];
  const issue = (code, detail) => issues.push({ code, detail });
  const {
    prs = {},
    runs = {},
    comparisons = {},
    blobs = {},
    policyRegressions,
    jobs = [],
    jobsByPr = {},
    mainSha,
  } = snapshot;

  for (const { number, base } of STACK) {
    const pr = prs[number];
    if (!pr) {
      issue('missing-pr', `PR #${number} is missing`);
      continue;
    }
    if (pr.state !== 'open' || pr.draft !== true) {
      issue('review-gate', `PR #${number} is not open and Draft`);
    }
    const parent = base === null ? { ref: 'main', sha: mainSha } : prs[base]?.head;
    if (!parent || !parent.sha) {
      issue('missing-parent', `PR #${number} has no verified base`);
    } else if (pr.base?.ref !== parent.ref || pr.base?.sha !== parent.sha) {
      issue('base-drift', `PR #${number} base does not match ${base ?? 'main'} HEAD`);
    }

    // GitHub's base ref and base SHA are metadata, not proof that the
    // proposed head actually contains that parent commit. A force-push can
    // leave both fields looking correct while silently dropping changes.
    if (parent?.sha) {
      const edge = comparisons.edges?.[number];
      if (!edge) {
        issue('missing-edge-evidence', `PR #${number} has no verified ancestry comparison`);
      } else if (
        edge.behind_by !== 0 ||
        !['ahead', 'identical'].includes(edge.status) ||
        edge.base_commit?.sha !== parent.sha ||
        edge.merge_base_commit?.sha !== parent.sha
      ) {
        issue('lost-stack-parent', `PR #${number} does not contain its declared base HEAD`);
      }
    }

    const latest = selectValidationRun(runs[number], number);
    if (!latest) {
      issue('missing-ci', `PR #${number} has no pull_request validation run`);
    } else if (latest.head_sha !== pr.head?.sha) {
      issue('stale-ci', `PR #${number} CI belongs to a different commit`);
    } else if (
      !Number.isSafeInteger(latest.id) ||
      !Number.isSafeInteger(latest.run_attempt) ||
      latest.run_attempt < 1
    ) {
      issue('ci-evidence-invalid', `PR #${number} CI has no verifiable run ID and attempt`);
    } else if (latest.status !== 'completed' || latest.conclusion !== 'success') {
      issue('ci-not-green', `PR #${number} latest CI is ${latest.status}/${latest.conclusion}`);
    }

    // A successful workflow conclusion alone is not proof that both required
    // security jobs actually executed on the exact run attempt. This applies
    // to every upstream PR, including divergent sibling #124.
    const attemptJobs = number === CANDIDATE_PR ? jobs : (jobsByPr[number] ?? []);
    for (const name of REQUIRED_JOBS) {
      const matches = attemptJobs.filter((entry) => entry.name === name);
      const job = matches[0];
      if (
        matches.length !== 1 ||
        !latest ||
        !job ||
        job.run_id !== latest.id ||
        job.run_attempt !== latest.run_attempt ||
        job.status !== 'completed' ||
        job.conclusion !== 'success'
      ) {
        issue(
          number === CANDIDATE_PR ? 'missing-candidate-job' : 'missing-upstream-job',
          `PR #${number} has no successful exact-attempt job: ${name}`,
        );
      } else {
        // A green job can contain skipped or failed security steps. Require
        // each gate exactly once, in execution order, on the attested attempt.
        let lastStepNumber = 0;
        for (const required of requiredStepsForPr(number, name)) {
          const steps = (job.steps ?? []).filter((step) => step.name === required);
          const step = steps[0];
          if (
            steps.length !== 1 ||
            !Number.isSafeInteger(step?.number) ||
            step.number <= lastStepNumber ||
            step.status !== 'completed' ||
            step.conclusion !== 'success'
          ) {
            issue(
              'missing-ci-step',
              `PR #${number} has no successful ordered step: ${name} / ${required}`,
            );
          } else {
            lastStepNumber = step.number;
          }
        }
      }
    }
  }

  const candidate = prs[CANDIDATE_PR];
  const mainComparison = comparisons.main;
  if (
    !candidate ||
    !mainComparison ||
    mainComparison.behind_by !== 0 ||
    !['ahead', 'identical'].includes(mainComparison.status) ||
    mainComparison.merge_base_commit?.sha !== mainSha
  ) {
    issue('main-not-integrated', `PR #${CANDIDATE_PR} does not include current main HEAD`);
  }
  for (const number of REQUIRED_ANCESTORS) {
    const source = prs[number];
    const comparison = comparisons[number];
    if (!candidate || !source || !comparison) {
      issue('missing-ancestry', `Cannot verify PR #${number} in PR #${CANDIDATE_PR}`);
    } else if (
      comparison.behind_by !== 0 ||
      !['ahead', 'identical'].includes(comparison.status) ||
      comparison.merge_base_commit?.sha !== source.head.sha
    ) {
      issue('lost-ancestor', `PR #${number} is not an ancestor of PR #${CANDIDATE_PR}`);
    }
  }

  // #109 was copied into #110 rather than merged as a parent. Check the
  // security-critical executable pinning implementation and race fixture.
  for (const path of PINNED_PATHS) {
    const pin = blobs[path];
    if (!pin?.source || !pin?.candidate || pin.source !== pin.candidate) {
      issue('copied-security-drift', `PR #109 security file differs in #${CANDIDATE_PR}: ${path}`);
    }
  }

  // #124 is a divergent sibling of #123, not a Git ancestor. Its exact
  // executable regression corpus must survive the #125 reconciliation.
  // The candidate may append new tests, but must not edit or drop old ones.
  if (
    typeof policyRegressions?.source !== 'string' ||
    policyRegressions.source.length === 0 ||
    typeof policyRegressions.candidate !== 'string' ||
    !policyRegressions.candidate.startsWith(policyRegressions.source)
  ) {
    issue(
      'divergent-policy-regressions-drift',
      `PR #124 CI-policy regression corpus is not preserved in #${CANDIDATE_PR}`,
    );
  }

  return issues;
}

export function decodePolicyRegressionSource(file) {
  if (
    file?.encoding !== 'base64' ||
    typeof file.content !== 'string' ||
    typeof file.sha !== 'string'
  ) {
    throw new Error('GitHub returned incomplete CI-policy regression source');
  }
  const base64 = file.content.replace(/\s/g, '');
  const decoded = Buffer.from(base64, 'base64');
  if (
    decoded.length === 0 ||
    decoded.length > 128 * 1024 ||
    decoded.toString('base64') !== base64
  ) {
    throw new Error('GitHub returned invalid CI-policy regression source');
  }
  return decoded.toString('utf8');
}

export async function collectStack({
  repo = 'vlovers/ai-office',
  token = process.env.GITHUB_TOKEN,
  request = fetch,
} = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Expected owner/repository');
  const root = `/repos/${repo}`;
  const get = async (path) => {
    const response = await request(`https://api.github.com${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ai-office-readonly-stack-audit',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      // Never print response bodies or authorization headers.
      throw new Error(`GitHub read failed (${response.status}): ${path.split('?')[0]}`);
    }
    return response.json();
  };

  const main = await get(`${root}/branches/main`);
  const prs = {};
  await Promise.all(
    STACK.map(async ({ number }) => {
      prs[number] = await get(`${root}/pulls/${number}`);
    }),
  );

  const runs = {};
  await Promise.all(
    STACK.map(async ({ number }) => {
      const head = prs[number].head.sha;
      runs[number] = await fetchWorkflowRuns(get, root, head);
    }),
  );

  const jobsByPr = {};
  await Promise.all(
    STACK.map(async ({ number }) => {
      const latest = selectValidationRun(runs[number], number);
      jobsByPr[number] = latest ? await fetchAttemptJobs(get, root, latest) : [];
    }),
  );
  const jobs = jobsByPr[CANDIDATE_PR];

  const comparisons = {
    main: await get(`${root}/compare/${main.commit.sha}...${prs[CANDIDATE_PR].head.sha}`),
    edges: {},
  };
  await Promise.all(
    STACK.map(async ({ number, base }) => {
      const parentSha = base === null ? main.commit.sha : prs[base].head.sha;
      comparisons.edges[number] = await get(
        `${root}/compare/${parentSha}...${prs[number].head.sha}`,
      );
    }),
  );
  await Promise.all(
    REQUIRED_ANCESTORS.map(async (number) => {
      comparisons[number] = await get(
        `${root}/compare/${prs[number].head.sha}...${prs[CANDIDATE_PR].head.sha}`,
      );
    }),
  );

  const blobs = {};
  await Promise.all(
    PINNED_PATHS.map(async (path) => {
      const encoded = path.split('/').map(encodeURIComponent).join('/');
      const [source, candidate] = await Promise.all(
        [109, CANDIDATE_PR].map((number) =>
          get(`${root}/contents/${encoded}?ref=${prs[number].head.sha}`),
        ),
      );
      blobs[path] = { source: source.sha, candidate: candidate.sha };
    }),
  );

  // PR #124 was reconciled without its Git commits. Fetch both exact source
  // files and attest the original regression suite is preserved verbatim.
  const policyPath = POLICY_REGRESSION_PATH.split('/').map(encodeURIComponent).join('/');
  const [policySource, policyCandidate] = await Promise.all(
    [124, CANDIDATE_PR].map((number) =>
      get(`${root}/contents/${policyPath}?ref=${prs[number].head.sha}`),
    ),
  );
  const policyRegressions = {
    source: decodePolicyRegressionSource(policySource),
    candidate: decodePolicyRegressionSource(policyCandidate),
  };

  // A new failed run or a rerun of the candidate's native job may appear
  // while ancestry is checked. Re-read CI before the final branch snapshot.
  const refreshedRuns = {};
  await Promise.all(
    STACK.map(async ({ number }) => {
      refreshedRuns[number] = await fetchWorkflowRuns(get, root, prs[number].head.sha);
    }),
  );
  const refreshedJobsByPr = {};
  await Promise.all(
    STACK.map(async ({ number }) => {
      const latest = selectValidationRun(refreshedRuns[number], number);
      refreshedJobsByPr[number] = latest ? await fetchAttemptJobs(get, root, latest) : [];
    }),
  );
  const refreshedJobs = refreshedJobsByPr[CANDIDATE_PR];
  assertStableCIEvidence(runs, refreshedRuns, jobs, refreshedJobs, jobsByPr, refreshedJobsByPr);

  // Ref reads and comparisons are not atomic across GitHub API requests.
  // A concurrent push must invalidate the snapshot rather than letting a
  // formerly green commit masquerade as the current integration candidate.
  const [finalMain, ...finalPrs] = await Promise.all([
    get(`${root}/branches/main`),
    ...STACK.map(({ number }) => get(`${root}/pulls/${number}`)),
  ]);
  if (finalMain.commit?.sha !== main.commit.sha) {
    throw new Error('GitHub main HEAD changed during stack audit');
  }
  for (const [index, { number }] of STACK.entries()) {
    const before = prs[number];
    const after = finalPrs[index];
    if (
      before.head?.sha !== after.head?.sha ||
      before.base?.sha !== after.base?.sha ||
      before.base?.ref !== after.base?.ref ||
      before.state !== after.state ||
      before.draft !== after.draft
    ) {
      throw new Error(`GitHub PR #${number} changed during stack audit`);
    }
  }

  return {
    mainSha: main.commit.sha,
    prs,
    runs,
    jobs,
    jobsByPr,
    comparisons,
    blobs,
    policyRegressions,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const snapshot = await collectStack({ repo: process.argv[2] ?? 'vlovers/ai-office' });
    const issues = auditStack(snapshot);
    console.log(`Integration PR #${CANDIDATE_PR}: ${snapshot.prs[CANDIDATE_PR].head.sha}`);
    console.log(`Current main: ${snapshot.mainSha}`);
    for (const { number } of STACK) {
      const run = selectValidationRun(snapshot.runs[number], number);
      console.log(
        `#${number}: ${snapshot.prs[number].head.sha.slice(0, 8)} CI ${run?.conclusion ?? 'missing'}`,
      );
    }
    for (const entry of issues) console.error(`[${entry.code}] ${entry.detail}`);
    console.log(`Audit: ${issues.length === 0 ? 'PASS' : `${issues.length} blocker(s)`}`);
    if (issues.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error('Read-only stack audit could not complete:', error.message);
    process.exitCode = 1;
  }
}
