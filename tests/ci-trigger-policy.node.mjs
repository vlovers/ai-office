import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateValidationWorkflow } from '../scripts/ci-trigger-policy.mjs';

const workflow = await readFile(
  new URL('../.github/workflows/validation.yml', import.meta.url),
  'utf8',
);
const issues = (text) => validateValidationWorkflow(text);

test('current CI covers all stacked PR base branches without privileged triggers', () => {
  assert.deepEqual(issues(workflow), []);
});

test('rejects a branch filter that suppresses security and future stacked PR checks', () => {
  const restricted = workflow.replace(
    '  pull_request:\n',
    "  pull_request:\n    branches: [main, 'test/**', 'fix/**']\n",
  );
  assert.match(issues(restricted).join(' '), /all branches/);
});

test('rejects path filters and restricted pull request event types', () => {
  for (const filter of ['paths: [src/**]', 'paths-ignore: [docs/**]', 'types: [opened]']) {
    const restricted = workflow.replace(
      '  pull_request:\n',
      '  pull_request:\n    ' + filter + '\n',
    );
    assert.match(issues(restricted).join(' '), /default activity types/);
  }
});

test('rejects privileged pull_request_target even when pull_request is present', () => {
  const unsafe = workflow.replace('  pull_request:\n', '  pull_request:\n  pull_request_target:\n');
  assert.match(issues(unsafe).join(' '), /pull_request_target/);
});

test('rejects workflow write permissions', () => {
  assert.match(
    issues(workflow.replace('  contents: read', '  contents: write')).join(' '),
    /read-only/,
  );
});

test('rejects missing native security, browser recovery, or offline audit checks', () => {
  for (const step of [
    'npm run test:sandbox',
    'npm run test:browser:workflow',
    'node --test tests/pr-stack-audit.node.mjs',
  ]) {
    assert.match(
      issues(workflow.replace(step, 'echo omitted')).join(' '),
      /missing validation step/,
    );
  }
});

test('rejects accidental real provider test execution', () => {
  assert.match(issues(workflow + '\n      - run: npm run test:real\n').join(' '), /real providers/);
});

test('rejects workflows without a pull_request event', () => {
  assert.match(
    issues(workflow.replace('  pull_request:', '  manual_only:')).join(' '),
    /missing pull_request/,
  );
});
