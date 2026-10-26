import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPortfolio, renderMarkdown } from '../scripts/portfolio-dashboard.mjs';

function mockFetch({ failRuns = false } = {}) {
  return async (url) => {
    const json = (status, data) => ({ ok: status === 200, status, json: async () => data });
    if (url.includes('/actions/runs')) return failRuns ? json(403, {}) : json(200, { workflow_runs: [{ status: 'completed', conclusion: 'success', html_url: 'https://github.com/example/actions/runs/1' }] });
    if (url.includes('/pulls?')) return json(200, [{ number: 1 }]);
    if (url.endsWith('/protection')) return json(404, {});
    throw new Error('unexpected request');
  };
}

test('snapshot does not equate passing workflow with required checks or unverified protection', async () => {
  const data = await buildPortfolio({ fetcher: mockFetch(), token: '', now: new Date('2026-10-26T10:00:00Z') });
  assert.equal(data.rows.length, 6);
  assert.equal(data.rows.find((r) => r.name === 'estima').branch, 'develop');
  assert.equal(data.rows[0].ci, 'latest run passed (not gate verified)');
  assert.equal(data.rows[0].protectedState, 'unverified');
  const output = renderMarkdown(data);
  assert.match(output, /not live monitoring/);
  assert.match(output, /not gate verified/);
  assert.match(output, /last-chapter/i);
});

test('rate limited workflow calls remain unknown', async () => {
  const data = await buildPortfolio({ fetcher: mockFetch({ failRuns: true }), token: '' });
  assert.ok(data.rows.every((r) => r.ci === 'unknown'));
  assert.ok(data.rows.every((r) => r.openPrs === 1));
});

test('API request is bounded and a full PR page is not reported as an exact count', async () => {
  const seen = [];
  const fetcher = async (url, options) => {
    seen.push(options);
    if (url.includes('/actions/runs')) return { ok: true, json: async () => ({ workflow_runs: [] }) };
    if (url.includes('/pulls?')) return { ok: true, json: async () => Array.from({ length: 100 }, (_, number) => ({ number })) };
    return { ok: false, status: 403 };
  };
  const data = await buildPortfolio({ fetcher, token: '' });
  assert.ok(seen.every((options) => options.signal instanceof AbortSignal));
  assert.ok(data.rows.every((row) => row.openPrs === '100+'));
  assert.ok(data.rows.every((row) => row.protectedState === 'unverified'));
});
