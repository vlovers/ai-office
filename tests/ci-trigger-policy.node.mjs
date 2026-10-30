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

test('rejects unexpected workflow event families', () => {
  for (const event of ['workflow_run', 'repository_dispatch']) {
    assert.match(
      issues(workflow.replace('  pull_request:\n', '  pull_request:\n  ' + event + ':\n')).join(
        ' ',
      ),
      /unexpected workflow trigger/,
    );
  }
});

test('rejects job-level permission escalation', () => {
  assert.match(
    issues(
      workflow.replace(
        '    runs-on: ubuntu-latest',
        '    permissions:\n      contents: write\n    runs-on: ubuntu-latest',
      ),
    ).join(' '),
    /override permissions/,
  );
});

test('rejects conditional or failure-tolerant security jobs', () => {
  for (const setting of ['if: false', 'continue-on-error: true']) {
    assert.match(
      issues(
        workflow.replace(
          '    runs-on: macos-latest',
          '    ' + setting + '\n    runs-on: macos-latest',
        ),
      ).join(' '),
      /skip execution or allow failure/,
    );
  }
});

test('rejects skipped or failure-tolerant required steps', () => {
  for (const setting of ['if: false', 'continue-on-error: true']) {
    assert.match(
      issues(
        workflow.replace(
          '        run: npm run test:sandbox',
          '        ' + setting + '\n        run: npm run test:sandbox',
        ),
      ).join(' '),
      /cannot be conditional or allow failure/,
    );
  }
});

test('commented-out and echoed commands do not count as executed gates', () => {
  for (const replacement of ['# run: npm run test:sandbox', 'run: echo npm run test:sandbox']) {
    assert.match(
      issues(workflow.replace('run: npm run test:sandbox', replacement)).join(' '),
      /missing validation step/,
    );
  }
});

test('multiline commands cannot hide an ignored gate exit status', () => {
  assert.match(
    issues(
      workflow.replace(
        'run: npm run typecheck',
        'run: |\n          npm run typecheck\n          exit 0',
      ),
    ).join(' '),
    /missing validation step/,
  );
});

test('requires native gates on macOS rather than Linux', () => {
  assert.match(
    issues(workflow.replace('runs-on: macos-latest', 'runs-on: ubuntu-latest')).join(' '),
    /must run on macos-latest/,
  );
});

test('rejects duplicated or missing native job definitions', () => {
  for (const replacement of ['  native-other:', '  native-sandbox:\n  native-sandbox:']) {
    assert.match(
      issues(workflow.replace('  native-sandbox:', replacement)).join(' '),
      /expected exactly one native-sandbox/,
    );
  }
});

test('rejects additional top-level permission grants', () => {
  assert.match(
    issues(workflow.replace('  contents: read', '  contents: read\n  id-token: write')).join(' '),
    /read-only/,
  );
});

test('rejects unreviewed sidecar jobs that escape the two-job security audit', () => {
  const extra = workflow.replace(
    '  native-sandbox:',
    '  provider-sidecar:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run test:real\n\n  native-sandbox:',
  );
  assert.match(issues(extra).join(' '), /unexpected validation job/);
});

test('rejects repository secret interpolation in otherwise valid CI steps', () => {
  const injected = workflow.replace(
    '        run: npm ci',
    '        run: npm ci\n        env:\n          TOKEN: ${{ secrets.PROVIDER_API_KEY }}',
  );
  assert.match(issues(injected).join(' '), /must not reference.*secrets/);
});

test('rejects unreviewed or dynamically resolved GitHub Actions', () => {
  for (const action of ['attacker/checkout@v1', '${{ inputs.action }}']) {
    const injected = workflow.replace('uses: actions/checkout@v7', 'uses: ' + action);
    assert.match(issues(injected).join(' '), /unreviewed GitHub Action/);
  }
});

test('rejects duplicate run keys that overwrite a required validation gate', () => {
  const overwritten = workflow.replace(
    '        run: npm run typecheck',
    '        run: npm run typecheck\n        run: echo bypassed',
  );
  assert.match(issues(overwritten).join(' '), /duplicate run keys/);
});

test('rejects hidden provider execution in an id-first step', () => {
  const hidden = workflow.replace(
    '      - name: TypeScript',
    '      - id: hidden-provider\n        run: npm run test:real\n      - name: TypeScript',
  );
  assert.match(issues(hidden).join(' '), /must not call real providers/);
});

test('rejects unreviewed inline action steps and duplicate uses keys', () => {
  const inline = workflow.replace(
    '      - name: TypeScript',
    '      - uses: attacker/action@v1\n      - name: TypeScript',
  );
  assert.match(issues(inline).join(' '), /unreviewed GitHub Action/);
  const duplicate = workflow.replace(
    '        uses: actions/checkout@v7',
    '        uses: actions/checkout@v7\n        uses: attacker/action@v1',
  );
  assert.match(issues(duplicate).join(' '), /duplicate uses keys/);
});

test('rejects an extra job with an inline YAML comment after its key', () => {
  const extra = workflow.replace(
    '  native-sandbox:',
    '  hidden-sidecar: # executes elsewhere\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run test:real\n\n  native-sandbox:',
  );
  assert.match(issues(extra).join(' '), /unexpected validation job/);
});

test('rejects unreviewed network commands and extra allowlisted action steps', () => {
  for (const injected of [
    workflow.replace(
      '      - name: TypeScript',
      '      - name: Unexpected network call\n        run: curl https://example.invalid\n      - name: TypeScript',
    ),
    workflow.replace(
      '      - name: TypeScript',
      '      - name: Extra checkout\n        uses: actions/checkout@v7\n      - name: TypeScript',
    ),
  ]) {
    assert.match(issues(injected).join(' '), /unreviewed validation step/);
  }
});

test('rejects workflow-wide environment and default execution overrides', () => {
  for (const injected of [
    workflow.replace('permissions:\n', 'env:\n  NODE_OPTIONS: --import ./untrusted.mjs\npermissions:\n'),
    workflow.replace('permissions:\n', 'defaults:\n  run:\n    shell: bash\npermissions:\n'),
  ]) {
    assert.match(issues(injected).join(' '), /unreviewed top-level/);
  }
});

test('rejects job-level defaults and execution timeout changes', () => {
  for (const injected of [
    workflow.replace(
      '    runs-on: ubuntu-latest',
      '    defaults:\n      run:\n        shell: bash\n    runs-on: ubuntu-latest',
    ),
    workflow.replace('    timeout-minutes: 10', '    timeout-minutes: 1'),
  ]) {
    assert.match(issues(injected).join(' '), /unreviewed job settings/);
  }
});

test('rejects step-level env, shell and working-directory overrides', () => {
  for (const setting of [
    'env:\n          NODE_OPTIONS: --import ./untrusted.mjs',
    'shell: bash -c true',
    'working-directory: /tmp',
  ]) {
    const injected = workflow.replace(
      '        run: npm run typecheck',
      '        run: npm run typecheck\n        ' + setting,
    );
    assert.match(issues(injected).join(' '), /unreviewed validation step/);
  }
});

test('rejects artifact upload path and retention changes', () => {
  for (const injected of [
    workflow.replace('          path: ${{ runner.temp }}/office-v4', '          path: .'),
    workflow.replace('          retention-days: 7', '          retention-days: 90'),
  ]) {
    assert.match(issues(injected).join(' '), /unreviewed validation step/);
  }
});

test('rejects unreviewed action inputs and extra artifact upload settings', () => {
  for (const injected of [
    workflow.replace('          cache: npm', '          cache: yarn'),
    workflow.replace(
      '          if-no-files-found: ignore',
      '          if-no-files-found: ignore\n          include-hidden-files: true',
    ),
  ]) {
    assert.match(issues(injected).join(' '), /unreviewed validation step/);
  }
});

test('rejects altered diagnostic execution and workflow dispatch inputs', () => {
  assert.match(
    issues(
      workflow.replace(
        "if: failure() && steps.formatting.outcome == 'failure'",
        'if: always()',
      ),
    ).join(' '),
    /unreviewed validation step/,
  );
  assert.match(
    issues(
      workflow.replace(
        '  workflow_dispatch:\n',
        '  workflow_dispatch:\n    inputs:\n      key:\n        required: false\n',
      ),
    ).join(' '),
    /workflow_dispatch must not accept/,
  );
});

test('rejects broad push triggers and modified cancellation policy', () => {
  assert.match(
    issues(workflow.replace('    branches: [main]', "    branches: ['**']")).join(' '),
    /push must target main only/,
  );
  assert.match(
    issues(workflow.replace('  cancel-in-progress: true', '  cancel-in-progress: false')).join(' '),
    /unreviewed workflow concurrency policy/,
  );
});

test('rejects rearranged security gates even if all commands remain present', () => {
  const injected = workflow.replace(
    '      - name: TypeScript\n        run: npm run typecheck\n      - name: Delivery security lint\n        run: npm run lint',
    '      - name: Delivery security lint\n        run: npm run lint\n      - name: TypeScript\n        run: npm run typecheck',
  );
  assert.match(issues(injected).join(' '), /unreviewed validation step/);
});
