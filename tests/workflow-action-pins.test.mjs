import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditWorkflowText,
  auditWorkflowDirectory,
} from '../scripts/check-workflow-action-pins.mjs';

const checkout = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
const artifact = 'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9';

function workflow(reference = checkout, options = 'with:\n          persist-credentials: false') {
  return `permissions:\n  contents: read\njobs:\n  test:\n    steps:\n      - name: Checkout\n        uses: ${reference}\n        ${options}\n      - name: Upload\n        uses: ${artifact}\n`;
}

test('real workflows pin all external actions and disable checkout credentials', () => {
  assert.ok(auditWorkflowDirectory() >= 1);
});

test('accepts pinned checkout with explicit token opt-out', () => {
  assert.deepEqual(auditWorkflowText(workflow()), []);
});

test('rejects mutable action tags, including artifact upload tags', () => {
  assert.match(auditWorkflowText(workflow('actions/checkout@v7')).join('\n'), /immutable/);
  assert.match(
    auditWorkflowText('steps:\n  - uses: actions/upload-artifact@v7').join('\n'),
    /immutable/,
  );
});

test('rejects short SHAs and GitHub expressions', () => {
  assert.match(auditWorkflowText(workflow('actions/checkout@3d3c42e')).join('\n'), /immutable/);
  assert.match(auditWorkflowText('steps:\n  - uses: ${{ inputs.action }}').join('\n'), /immutable/);
});

test('rejects missing and enabled checkout credentials', () => {
  assert.match(
    auditWorkflowText(workflow(checkout, 'with:\n          fetch-depth: 0')).join('\n'),
    /persist-credentials/,
  );
  assert.match(
    auditWorkflowText(workflow(checkout, 'with:\n          persist-credentials: true')).join('\n'),
    /persist-credentials/,
  );
});

test('does not accept a false token setting in env instead of with', () => {
  assert.match(
    auditWorkflowText(workflow(checkout, 'env:\n          persist-credentials: false')).join('\n'),
    /persist-credentials/,
  );
});

test('rejects checkout credential opt-out nested inside another with key', () => {
  const text = `steps:\n  - uses: ${checkout}\n    with:\n      unrelated:\n        persist-credentials: false\n`;
  assert.match(auditWorkflowText(text).join('\\n'), /persist-credentials/);
});

test('accepts checkout credential opt-out only as a direct with child', () => {
  const text = `permissions:\n  contents: read\nsteps:\n  - uses: ${checkout}\n    with:\n      persist-credentials: false\n      fetch-depth: 0\n`;
  assert.deepEqual(auditWorkflowText(text), []);
});

test('does not accept a false token setting from a different step', () => {
  const text = `steps:\n  - uses: ${checkout}\n  - name: unrelated\n    with:\n      persist-credentials: false\n`;
  assert.match(auditWorkflowText(text).join('\n'), /persist-credentials/);
});

test('allows local actions and digest-pinned Docker actions', () => {
  const text = `permissions:\n  contents: read\nsteps:\n  - uses: ./local/action\n  - uses: docker://alpine@sha256:${'a'.repeat(64)}\n`;
  assert.deepEqual(auditWorkflowText(text), []);
});

test('rejects Docker image tags without digest', () => {
  assert.match(auditWorkflowText('steps:\n  - uses: docker://alpine:3.20').join('\n'), /immutable/);
});

test('requires explicit read-only workflow token permissions', () => {
  assert.match(auditWorkflowText(workflow().replace('permissions:\n  contents: read\n', '')).join('\n'), /missing top-level/);
  assert.match(auditWorkflowText(workflow().replace('contents: read', 'contents: write')).join('\n'), /write token permissions/);
  assert.match(auditWorkflowText(workflow().replace('permissions:\n  contents: read', 'permissions: write-all')).join('\n'), /explicit mapping/);
  assert.match(auditWorkflowText(workflow().replace('contents: read', 'contents: \${{ inputs.scope }}')).join('\n'), /invalid or dynamic/);
});

test('rejects job-level write permission escalation', () => {
  assert.match(auditWorkflowText(workflow().replace('    steps:', '    permissions:\n      issues: write\n    steps:')).join('\n'), /write token permissions/);
});

test('rejects empty uses and YAML-spaced uses keys', () => {
  assert.match(auditWorkflowText(workflow().replace('uses: ' + artifact, 'uses:')).join('\n'), /action must use/);
  assert.match(auditWorkflowText(workflow().replace('uses: ' + artifact, 'uses : ' + artifact.replace(/@[a-f0-9]{40}$/, '@v7'))).join('\n'), /action must use/);
});

test('rejects dynamic, traversing and malformed local action references', () => {
  for (const reference of ['./../external/action', './local/../action', './local//action', './\${{ inputs.path }}', './']) {
    assert.match(auditWorkflowText(workflow().replace(artifact, reference)).join('\n'), /action must use/, reference);
  }
});

test('rejects traversal and dynamic external references even when SHA-shaped', () => {
  const sha = 'a'.repeat(40);
  for (const reference of ['example/../action@' + sha, 'example//action@' + sha, 'example/action@' + sha + '\${{ inputs.extra }}']) {
    assert.match(auditWorkflowText(workflow().replace(artifact, reference)).join('\n'), /action must use/, reference);
  }
});

test('rejects dynamic Docker image names even with a digest', () => {
  const image = 'docker://$IMAGE@sha256:' + 'a'.repeat(64);
  assert.match(auditWorkflowText(workflow().replace(artifact, image)).join('\n'), /action must use/);
});

test('rejects duplicate or nonliteral checkout credential settings', () => {
  assert.match(auditWorkflowText(workflow().replace('persist-credentials: false', 'persist-credentials: false\n          persist-credentials: true')).join('\n'), /exactly one/);
  assert.match(auditWorkflowText(workflow().replace('persist-credentials: false', "persist-credentials: 'false'")).join('\n'), /exactly one/);
});

test('accepts static local reusable workflows and digest-pinned registry images', () => {
  const input = workflow().replace(artifact, './.github/workflows/reusable.yml') +
    '\n  - uses: docker://ghcr.io/example/image@sha256:' + 'a'.repeat(64) + '\n';
  assert.deepEqual(auditWorkflowText(input), []);
});
