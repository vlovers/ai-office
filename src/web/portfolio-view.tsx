import React, { useEffect, useState } from 'react';

const PROJECTS = [
  { slug: 'ai-office', branch: 'main' },
  { slug: 'grid-atlas', branch: 'main' },
  { slug: 'rulewitness', branch: 'main' },
  { slug: 'mutation-boundary', branch: 'main' },
  { slug: 'estima', branch: 'develop' },
  { slug: 'last-chapter', branch: 'main' },
] as const;

type PortfolioRow = {
  slug: string;
  branch: string;
  state: string;
  runUrl?: string;
  openPrs: string;
  note?: string;
};

async function readJson(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(`https://api.github.com/repos/vlovers/${path}`, {
    signal,
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function loadProject(project: (typeof PROJECTS)[number], signal: AbortSignal): Promise<PortfolioRow> {
  const [runs, prs] = await Promise.allSettled([
    readJson(`${project.slug}/actions/runs?branch=${project.branch}&per_page=1`, signal),
    readJson(`${project.slug}/pulls?state=open&per_page=100`, signal),
  ]);
  const workflows =
    runs.status === 'fulfilled' &&
    typeof runs.value === 'object' &&
    runs.value !== null &&
    'workflow_runs' in runs.value &&
    Array.isArray(runs.value.workflow_runs)
      ? runs.value.workflow_runs
      : [];
  const latest = workflows[0] as
    | { status?: string; conclusion?: string; html_url?: string }
    | undefined;
  const state = !latest
    ? 'Unknown'
    : latest.status !== 'completed'
      ? 'Pending'
      : latest.conclusion === 'success'
        ? 'Latest workflow passed · gates unverified'
        : latest.conclusion === 'failure'
          ? 'Latest workflow failed'
          : 'Unknown';
  const count = prs.status === 'fulfilled' && Array.isArray(prs.value) ? prs.value.length : null;
  return {
    slug: project.slug,
    branch: project.branch,
    state,
    runUrl: latest?.html_url,
    openPrs: count === null ? 'Unknown' : count === 100 ? '100+' : String(count),
    note: project.slug === 'last-chapter' ? 'Game development currently uses a separate integration branch.' : undefined,
  };
}

/** Browser-only, read-only public GitHub overview. No credentials are accepted or stored. */
export function PortfolioView() {
  const [rows, setRows] = useState<PortfolioRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [updated, setUpdated] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let mounted = true;
    const timeout = window.setTimeout(() => controller.abort(), 10000);
    setLoading(true);
    void Promise.all(
      PROJECTS.map(async (project) => {
        try {
          return await loadProject(project, controller.signal);
        } catch {
          return { slug: project.slug, branch: project.branch, state: 'Unknown', openPrs: 'Unknown' };
        }
      }),
    ).then((result) => {
      if (!mounted) return;
      setRows(result);
      setUpdated(new Date().toLocaleString());
      setLoading(false);
    });
    return () => {
      mounted = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [revision]);

  return (
    <section id="portfolio" aria-labelledby="portfolio-heading" className="panel">
      <div className="section-header">
        <div>
          <span className="eyebrow">ENGINEERING / PORTFOLIO</span>
          <h2 id="portfolio-heading">Project health</h2>
        </div>
        <button className="secondary" type="button" onClick={() => setRevision((value) => value + 1)}>
          Refresh
        </button>
      </div>
      <p>
        Public GitHub snapshot only. The latest workflow is <strong>not</strong> proof that all
        required checks passed. Private repositories and API failures appear as Unknown. No
        credentials are stored or sent by AI Office.
      </p>
      <p role="status">{loading ? 'Loading GitHub status…' : `Checked ${updated}`}</p>
      <div className="table-scroll" role="region" aria-label="Portfolio projects" tabIndex={0}>
        <table>
          <thead>
            <tr>
              <th scope="col">Repository</th>
              <th scope="col">Branch</th>
              <th scope="col">Latest workflow</th>
              <th scope="col">Open PRs</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.slug}>
                <td>
                  <a href={`https://github.com/vlovers/${row.slug}`} target="_blank" rel="noreferrer">
                    {row.slug} ↗
                  </a>
                  {row.note && <small style={{ display: 'block' }}>{row.note}</small>}
                </td>
                <td>{row.branch}</td>
                <td>
                  {row.runUrl ? (
                    <a href={row.runUrl} target="_blank" rel="noreferrer">
                      {row.state} ↗
                    </a>
                  ) : (
                    row.state
                  )}
                </td>
                <td>{row.openPrs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        Independent reviews and effective branch rules are not verified here. See{' '}
        <a href="https://github.com/vlovers/ai-office/issues/87" target="_blank" rel="noreferrer">
          governance tracking #87
        </a>.
      </p>
    </section>
  );
}
