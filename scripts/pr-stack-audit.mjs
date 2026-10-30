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
];

export const REQUIRED_ANCESTORS = [108, 110, 112];
export const PINNED_PATHS = ['src/server/qa-runner.ts', 'tests/qa-plan-preflight-race.test.ts'];
export const REQUIRED_JOBS = [
  'TypeScript, tests, smoke, build and formatting',
  'Native Codex filesystem policy (no inference)',
];

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
      (left, right) =>
        right.id - left.id || (right.run_attempt ?? 0) - (left.run_attempt ?? 0),
    )[0];
}

// Read the jobs for the exact attempt; never silently trust a truncated page.
export async function fetchAttemptJobs(get, root, run) {
  if (!Number.isSafeInteger(run?.id) || !Number.isSafeInteger(run?.run_attempt)) {
    throw new Error('Candidate CI run has no verifiable ID and attempt');
  }
  const jobs = [];
  for (let page = 1; page <= 10; page += 1) {
    const result = await get(
      `${root}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`,
    );
    if (!Number.isSafeInteger(result.total_count) || !Array.isArray(result.jobs)) {
      throw new Error('GitHub returned incomplete candidate job evidence');
    }
    jobs.push(...result.jobs);
    if (jobs.length === result.total_count) return jobs;
    if (jobs.length > result.total_count || result.jobs.length === 0) {
      throw new Error('GitHub candidate job pages are inconsistent');
    }
  }
  throw new Error('GitHub candidate job evidence exceeds pagination limit');
}

// Pure, deterministic evaluation: tests never need a token or network access.
export function auditStack(snapshot) {
  const issues = [];
  const issue = (code, detail) => issues.push({ code, detail });
  const { prs = {}, runs = {}, comparisons = {}, blobs = {}, jobs = [], mainSha } = snapshot;

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

    const latest = selectValidationRun(runs[number], number);
    if (!latest) {
      issue('missing-ci', `PR #${number} has no pull_request validation run`);
    } else if (latest.head_sha !== pr.head?.sha) {
      issue('stale-ci', `PR #${number} CI belongs to a different commit`);
    } else if (latest.status !== 'completed' || latest.conclusion !== 'success') {
      issue('ci-not-green', `PR #${number} latest CI is ${latest.status}/${latest.conclusion}`);
    }
  }

  const candidate = prs[116];
  const mainComparison = comparisons.main;
  if (
    !candidate ||
    !mainComparison ||
    mainComparison.behind_by !== 0 ||
    !['ahead', 'identical'].includes(mainComparison.status) ||
    mainComparison.merge_base_commit?.sha !== mainSha
  ) {
    issue('main-not-integrated', 'PR #116 does not include current main HEAD');
  }
  for (const number of REQUIRED_ANCESTORS) {
    const source = prs[number];
    const comparison = comparisons[number];
    if (!candidate || !source || !comparison) {
      issue('missing-ancestry', `Cannot verify PR #${number} in PR #116`);
    } else if (
      comparison.behind_by !== 0 ||
      !['ahead', 'identical'].includes(comparison.status) ||
      comparison.merge_base_commit?.sha !== source.head.sha
    ) {
      issue('lost-ancestor', `PR #${number} is not an ancestor of PR #116`);
    }
  }

  // #109 was copied into #110 rather than merged as a parent. Check the
  // security-critical executable pinning implementation and race fixture.
  for (const path of PINNED_PATHS) {
    const pin = blobs[path];
    if (!pin?.source || !pin?.candidate || pin.source !== pin.candidate) {
      issue('copied-security-drift', `PR #109 security file differs in #116: ${path}`);
    }
  }

  const candidateRun = selectValidationRun(runs[116], 116);
  for (const name of REQUIRED_JOBS) {
    const matches = jobs.filter((entry) => entry.name === name);
    const job = matches[0];
    if (
      matches.length !== 1 ||
      !candidateRun ||
      !job ||
      job.run_id !== candidateRun.id ||
      job.run_attempt !== candidateRun.run_attempt ||
      job.status !== 'completed' ||
      job.conclusion !== 'success'
    ) {
      issue('missing-candidate-job', `PR #116 has no successful exact-attempt job: ${name}`);
    }
  }

  return issues;
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
      const result = await get(
        `${root}/actions/runs?head_sha=${head}&event=pull_request&per_page=100`,
      );
      if (!Array.isArray(result.workflow_runs)) {
        throw new Error(`GitHub returned incomplete PR #${number} CI evidence`);
      }
      runs[number] = result.workflow_runs;
    }),
  );

  const latestCandidate = selectValidationRun(runs[116], 116);
  const jobs = latestCandidate ? await fetchAttemptJobs(get, root, latestCandidate) : [];

  const comparisons = {
    main: await get(`${root}/compare/${main.commit.sha}...${prs[116].head.sha}`),
  };
  await Promise.all(
    REQUIRED_ANCESTORS.map(async (number) => {
      comparisons[number] = await get(
        `${root}/compare/${prs[number].head.sha}...${prs[116].head.sha}`,
      );
    }),
  );

  const blobs = {};
  await Promise.all(
    PINNED_PATHS.map(async (path) => {
      const encoded = path.split('/').map(encodeURIComponent).join('/');
      const [source, candidate] = await Promise.all(
        [109, 116].map((number) => get(`${root}/contents/${encoded}?ref=${prs[number].head.sha}`)),
      );
      blobs[path] = { source: source.sha, candidate: candidate.sha };
    }),
  );

  return { mainSha: main.commit.sha, prs, runs, jobs, comparisons, blobs };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const snapshot = await collectStack({ repo: process.argv[2] ?? 'vlovers/ai-office' });
    const issues = auditStack(snapshot);
    console.log(`Integration PR #116: ${snapshot.prs[116].head.sha}`);
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
