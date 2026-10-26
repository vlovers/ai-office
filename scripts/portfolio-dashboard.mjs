import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Read-only portfolio snapshot. Node 24+; no dependencies or writes.
 * Usage: GITHUB_TOKEN=... node scripts/portfolio-dashboard.mjs
 * Missing credentials, rate limits and absent CI always remain unknown.
 */
const REPOSITORIES = [
  { name: 'ai-office', branch: 'main' },
  { name: 'grid-atlas', branch: 'main' },
  { name: 'rulewitness', branch: 'main' },
  { name: 'mutation-boundary', branch: 'main' },
  { name: 'estima', branch: 'develop' },
  { name: 'last-chapter', branch: 'main', note: 'Game integration branch differs from bootstrap main' },
];

export async function buildPortfolio({ fetcher = fetch, token = process.env.GITHUB_TOKEN, now = new Date() } = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;

  async function request(path) {
    const response = await fetcher(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  const rows = await Promise.all(REPOSITORIES.map(async ({ name, branch, note }) => {
    const full = `vlovers/${name}`;
    const encoded = full;
    const results = await Promise.allSettled([
      request(`/repos/${encoded}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=20`),
      request(`/repos/${encoded}/pulls?state=open&per_page=100`),
      request(`/repos/${encoded}/branches/${encodeURIComponent(branch)}/protection`),
    ]);
    const [runs, pulls, protection] = results;
    const runData = runs.status === 'fulfilled' ? runs.value.workflow_runs ?? [] : null;
    // A latest workflow result is not a complete required-check verdict.
    const latest = runData?.[0];
    const ci = !runData ? 'unknown' : !latest ? 'unknown' :
      latest.status !== 'completed' ? 'pending' :
      latest.conclusion === 'success' ? 'latest run passed (not gate verified)' :
      latest.conclusion === 'failure' ? 'latest run failed' : 'unknown';
    const openPrs = pulls.status === 'fulfilled' ? (pulls.value.length === 100 ? '100+' : pulls.value.length) : null;
    const protectedState = protection.status === 'fulfilled' ? 'API protection present (rulesets unverified)' : 'unverified';
    return { name, full, branch, ci, runUrl: latest?.html_url, openPrs, protectedState, note };
  }));
  return { checkedAt: now.toISOString(), rows };
}

function escapeCell(value) {
  return String(value ?? 'unknown').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function renderMarkdown({ checkedAt, rows }) {
  const lines = [
    '# Engineering portfolio — read-only snapshot',
    '',
    `Checked at: ${checkedAt}. This is a snapshot, not live monitoring. CI describes only the latest returned workflow run, **not** all required checks. PR counts may be truncated at 100. Independent review and effective branch rules are **not verified** by this report.`,
    '',
    '| Repository | Branch | Latest CI | Open PRs | Branch protection | Notes |',
    '| --- | --- | --- | ---: | --- | --- |',
  ];
  for (const row of rows) {
    const repo = `[${row.name}](https://github.com/${row.full})`;
    const ci = row.runUrl ? `[${escapeCell(row.ci)}](${row.runUrl})` : escapeCell(row.ci);
    lines.push(`| ${repo} | \`${row.branch}\` | ${ci} | ${row.openPrs ?? 'unknown'} | ${escapeCell(row.protectedState)} | ${escapeCell(row.note ?? '')} |`);
  }
  lines.push('', 'Protection API failures (including 403/404) are shown as **unverified**, not unprotected. No merges, writes, secrets, or branch-setting changes are performed.', '');
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(renderMarkdown(await buildPortfolio()));
  } catch (error) {
    process.stderr.write(`Portfolio snapshot failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
