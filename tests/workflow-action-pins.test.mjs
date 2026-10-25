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

function expectFinding(source, pattern) {
  assert.match(auditWorkflowText(source).join('\n'), pattern);
}

test('requires explicit read-only workflow token permissions', () => {
  expectFinding(workflow().replace('permissions:\n  contents: read\n', ''), /missing top-level/);
  expectFinding(workflow().replace('contents: read', 'contents: write'), /write token permissions/);
  expectFinding(
    workflow().replace('permissions:\n  contents: read', 'permissions: write-all'),
    /explicit mapping/,
  );
  expectFinding(
    workflow().replace('contents: read', 'contents: ' + '$' + '{{ inputs.scope }}'),
    /invalid or dynamic/,
  );
});

test('rejects job-level write permission escalation', () => {
  expectFinding(
    workflow().replace('    steps:', '    permissions:\n      issues: write\n    steps:'),
    /write token permissions/,
  );
});

test('rejects empty uses and YAML-spaced uses keys', () => {
  expectFinding(workflow().replace('uses: ' + artifact, 'uses:'), /action must use/);
  expectFinding(
    workflow().replace('uses: ' + artifact, 'uses : actions/upload-artifact@v7'),
    /action must use/,
  );
});

test('rejects dynamic, traversing and malformed local action references', () => {
  const badReferences = [
    './../external/action',
    './local/../action',
    './local//action',
    './' + '$' + '{{ inputs.path }}',
    './',
  ];
  for (const reference of badReferences) {
    expectFinding(workflow().replace(artifact, reference), /action must use/);
  }
});

test('rejects traversal and dynamic external references even when SHA-shaped', () => {
  const sha = 'a'.repeat(40);
  const badReferences = [
    'example/../action@' + sha,
    'example//action@' + sha,
    'example/action@' + sha + '$' + '{{ inputs.extra }}',
  ];
  for (const reference of badReferences) {
    expectFinding(workflow().replace(artifact, reference), /action must use/);
  }
});

test('rejects dynamic Docker image names even with a digest', () => {
  const image = 'docker://$IMAGE@sha256:' + 'a'.repeat(64);
  expectFinding(workflow().replace(artifact, image), /action must use/);
});

test('rejects duplicate or nonliteral checkout credential settings', () => {
  expectFinding(
    workflow().replace(
      'persist-credentials: false',
      'persist-credentials: false\n          persist-credentials: true',
    ),
    /exactly one/,
  );
  expectFinding(
    workflow().replace('persist-credentials: false', "persist-credentials: 'false'"),
    /exactly one/,
  );
});

test('accepts static local reusable workflows and digest-pinned registry images', () => {
  const input =
    workflow().replace(artifact, './.github/workflows/reusable.yml') +
    '\n  - uses: docker://ghcr.io/example/image@sha256:' +
    'a'.repeat(64) +
    '\n';
  assert.deepEqual(auditWorkflowText(input), []);
});

test('rejects quoted and explicit YAML security keys', () => {
  expectFinding(
    workflow().replace('uses: ' + artifact, '"uses": actions/upload-artifact@v7'),
    /unsupported YAML syntax/,
  );
  expectFinding(workflow().replace('permissions:', "'permissions':"), /unsupported YAML syntax/);
  expectFinding(
    workflow().replace('uses: ' + artifact, '? uses\n        : actions/upload-artifact@v7'),
    /unsupported YAML syntax/,
  );
});

test('rejects flow-form and aliased jobs or steps', () => {
  expectFinding(
    workflow().replace(
      '      - name: Upload\n        uses: ' + artifact,
      '      - { uses: actions/upload-artifact@v7 }',
    ),
    /unsupported YAML syntax/,
  );
  expectFinding(workflow().replace('    steps:', '    steps: *shared'), /block mappings/);
  expectFinding(workflow().replace('jobs:', 'jobs: {'), /block mappings/);
});

test('rejects YAML merge keys that can override step security', () => {
  expectFinding(workflow() + '      - <<: *shared\n', /unsupported YAML syntax/);
});

test('rejects duplicate checkout with mappings even when one disables credentials', () => {
  expectFinding(
    workflow().replace(
      'persist-credentials: false',
      'persist-credentials: false\n        with:\n          persist-credentials: true',
    ),
    /exactly one/,
  );
});

test('rejects job-level write permissions at any valid YAML indentation', () => {
  for (const depth of [4, 6, 8]) {
    const indent = ' '.repeat(depth);
    const input =
      'permissions:\n  contents: read\njobs:\n  test:\n' +
      indent +
      'permissions:\n' +
      indent +
      '  issues: write\n' +
      indent +
      'steps:\n' +
      indent +
      '  - uses: ' +
      artifact +
      '\n';
    expectFinding(input, /write token permissions/);
  }
});

test('accepts explicitly read-only job permissions with nonstandard indentation', () => {
  const input =
    'permissions:\n  contents: read\njobs:\n  test:\n' +
    '      permissions:\n        contents: read\n' +
    '      steps:\n        - uses: ' +
    artifact +
    '\n';
  assert.deepEqual(auditWorkflowText(input), []);
});

test('rejects inline job mappings that hide permissions or actions', () => {
  for (const job of [
    '  test: { permissions: write-all, runs-on: ubuntu-latest, steps: [] }',
    '  "test": { permissions: write-all, runs-on: ubuntu-latest, steps: [] }',
    '  test: &shared { permissions: write-all, runs-on: ubuntu-latest, steps: [] }',
    '  test:\n    { permissions: write-all, runs-on: ubuntu-latest, steps: [] }',
  ]) {
    expectFinding(
      'permissions:\n  contents: read\njobs:\n' + job + '\n',
      /unsupported YAML syntax/,
    );
  }
});

test('rejects quoted explicit complex YAML keys', () => {
  expectFinding(
    'permissions:\n  contents: read\njobs:\n  test:\n    steps:\n      - ? "uses"\n        : actions/upload-artifact@v7\n',
    /unsupported YAML syntax/,
  );
});

test('rejects YAML anchors that decorate an otherwise invisible action mapping', () => {
  const input = workflow().replace(
    '      - name: Upload\n        uses: ' + artifact,
    '      - &unreviewed uses: actions/upload-artifact@v7',
  );
  expectFinding(input, /unsupported YAML syntax/);
});

test('rejects explicit YAML mapping tags that hide mutable actions', () => {
  const input = workflow().replace(
    '      - name: Upload\n        uses: ' + artifact,
    '      - !!map uses: actions/upload-artifact@v7',
  );
  expectFinding(input, /unsupported YAML syntax/);
});

test('rejects aliased action steps and anchored job mappings', () => {
  expectFinding(
    workflow() + '      - *shared_step\n',
    /unsupported YAML syntax/,
  );
  expectFinding(
    workflow().replace('  test:', '  test: &shared_job'),
    /unsupported YAML syntax/,
  );
});
