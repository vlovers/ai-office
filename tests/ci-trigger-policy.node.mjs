import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import {
  REQUIRED_VALIDATION_CHECKOUT_PATHS,
  REQUIRED_VALIDATION_SCRIPTS,
  validateValidationCheckoutPaths,
  validateValidationPackage,
  validateValidationWorkflow,
  validateValidationWorkflowInventory,
} from '../scripts/ci-trigger-policy.mjs';

const workflow = await readFile(
  new URL('../.github/workflows/validation.yml', import.meta.url),
  'utf8',
);
const issues = (text) => validateValidationWorkflow(text);
const packageManifest = await readFile(new URL('../package.json', import.meta.url), 'utf8');
const packageIssues = (source) => validateValidationPackage(source);

test('current CI covers all stacked PR base branches without privileged triggers', () => {
  assert.deepEqual(issues(workflow), []);
});

test('pre-install policy executes before npm install with lifecycle scripts disabled on both runners', () => {
  const preflight =
    '      - name: Pre-install checkout and CI policy (dependency-free)\n' +
    '        run: node --test tests/ci-trigger-policy.node.mjs\n';
  const install = '      - name: Install dependencies\n        run: npm ci --ignore-scripts\n';
  const linux = workflow.slice(
    workflow.indexOf('  checks:'),
    workflow.indexOf('  native-sandbox:'),
  );
  const macos = workflow.slice(workflow.indexOf('  native-sandbox:'));
  for (const job of [linux, macos]) {
    assert.equal(job.split(preflight).length - 1, 1);
    assert.equal(job.split(install).length - 1, 1);
    assert.ok(job.indexOf(preflight) < job.indexOf(install));
  }
  for (const bypass of [
    workflow.replace('run: npm ci --ignore-scripts', 'run: npm ci'),
    workflow.replace('run: npm ci --ignore-scripts', 'run: npm ci --ignore-scripts=false'),
    workflow.replace(preflight, ''),
    workflow.replace(preflight + install, install + preflight),
  ]) {
    assert.match(issues(bypass).join(' '), /unreviewed validation step/);
  }
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
    workflow.replace(
      'permissions:\n',
      'env:\n  NODE_OPTIONS: --import ./untrusted.mjs\npermissions:\n',
    ),
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
      workflow.replace("if: failure() && steps.formatting.outcome == 'failure'", 'if: always()'),
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

test('pins every npm command executed by the Linux and macOS validation jobs', () => {
  assert.deepEqual(packageIssues(packageManifest), []);
  for (const name of Object.keys(REQUIRED_VALIDATION_SCRIPTS)) {
    const candidate = JSON.parse(packageManifest);
    candidate.scripts[name] = 'echo skipped';
    assert.ok(
      packageIssues(JSON.stringify(candidate)).some((issue) =>
        issue.includes(`validation script ${name} changed or missing`),
      ),
      `must reject bypass of ${name}`,
    );
  }
});

test('rejects missing native QA and browser recovery scripts', () => {
  for (const name of ['test:sandbox', 'test:workflow:native', 'test:browser:workflow']) {
    const candidate = JSON.parse(packageManifest);
    delete candidate.scripts[name];
    assert.ok(packageIssues(JSON.stringify(candidate)).some((issue) => issue.includes(name)));
  }
});

test('rejects implicit npm lifecycle execution around required validation gates', () => {
  for (const name of [
    'pretest',
    'postbuild',
    'pretypecheck',
    'pretest:sandbox',
    'posttest:workflow:native',
    'pretest:browser:workflow',
    'preinstall',
    'install',
    'postinstall',
    'prepublish',
    'preprepare',
    'prepare',
    'postprepare',
    'dependencies',
  ]) {
    const candidate = JSON.parse(packageManifest);
    candidate.scripts[name] = 'node scripts/real-codex-smoke.ts';
    assert.ok(
      packageIssues(JSON.stringify(candidate)).some((issue) =>
        issue.includes(`lifecycle hook ${name}`),
      ),
      `must reject implicit hook ${name}`,
    );
  }
});

test('rejects invalid package manifests without rejecting unrelated offline scripts', () => {
  for (const source of ['{', '{}', '{"scripts":[]}', '{"scripts":null}']) {
    assert.notEqual(packageIssues(source).length, 0);
  }
  const candidate = JSON.parse(packageManifest);
  candidate.scripts['test:offline-extra'] = 'node --test tests/offline-extra.node.mjs';
  assert.deepEqual(packageIssues(JSON.stringify(candidate)), []);
});

const approvedWorkflows = [{ name: 'validation.yml', kind: 'file' }];

test('checked-out workflow directory contains only the reviewed regular workflow', async () => {
  const path = new URL('../.github/workflows', import.meta.url);
  const [directory, entries] = await Promise.all([
    lstat(path),
    readdir(path, { withFileTypes: true }),
  ]);
  const directoryKind = directory.isSymbolicLink()
    ? 'symlink'
    : directory.isDirectory()
      ? 'directory'
      : 'other';
  const inventory = entries.map((entry) => ({
    name: entry.name,
    kind: entry.isSymbolicLink()
      ? 'symlink'
      : entry.isFile()
        ? 'file'
        : entry.isDirectory()
          ? 'directory'
          : 'other',
  }));
  assert.deepEqual(validateValidationWorkflowInventory(directoryKind, inventory), []);
});

test('workflow inventory rejects additional workflows, including hidden and YAML variants', () => {
  for (const name of ['shadow.yml', 'deploy.yaml', '.hidden.yml', 'README.md']) {
    assert.match(
      validateValidationWorkflowInventory('directory', [
        ...approvedWorkflows,
        { name, kind: 'file' },
      ]).join(' '),
      /unreviewed workflow directory entry/,
    );
  }
});

test('workflow inventory rejects missing or duplicate approved workflows', () => {
  for (const inventory of [[], [...approvedWorkflows, ...approvedWorkflows]]) {
    assert.match(
      validateValidationWorkflowInventory('directory', inventory).join(' '),
      /expected exactly one regular validation.yml workflow/,
    );
  }
});

test('workflow inventory rejects symlinked or non-regular workflow entries', () => {
  for (const kind of ['symlink', 'directory', 'other']) {
    assert.match(
      validateValidationWorkflowInventory('directory', [{ name: 'validation.yml', kind }]).join(
        ' ',
      ),
      /expected exactly one regular validation.yml workflow/,
    );
    assert.match(
      validateValidationWorkflowInventory('directory', [
        ...approvedWorkflows,
        { name: 'nested', kind },
      ]).join(' '),
      /unreviewed workflow directory entry/,
    );
  }
});

test('workflow inventory fails closed on an untrusted or unreadable directory', () => {
  for (const kind of ['symlink', 'file', 'other']) {
    assert.match(
      validateValidationWorkflowInventory(kind, approvedWorkflows).join(' '),
      /workflow directory must be a real directory/,
    );
  }
  assert.match(
    validateValidationWorkflowInventory('directory', undefined).join(' '),
    /workflow inventory is unavailable/,
  );
});

const checkoutPathKinds = async () => {
  const kinds = {};
  for (const path of Object.keys(REQUIRED_VALIDATION_CHECKOUT_PATHS)) {
    let info;
    try {
      info = await lstat(new URL(`../${path}`, import.meta.url));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        kinds[path] = 'missing';
        continue;
      }
      throw error;
    }
    kinds[path] = info.isSymbolicLink()
      ? 'symlink'
      : info.isFile()
        ? 'file'
        : info.isDirectory()
          ? 'directory'
          : 'other';
  }
  return kinds;
};

test('CI checkout has trusted file types and no npm overrides', async () => {
  assert.deepEqual(validateValidationCheckoutPaths(await checkoutPathKinds()), []);
});

test('CI checkout rejects symlinks at every protected path', () => {
  for (const path of Object.keys(REQUIRED_VALIDATION_CHECKOUT_PATHS)) {
    const candidate = { ...REQUIRED_VALIDATION_CHECKOUT_PATHS, [path]: 'symlink' };
    assert.ok(
      validateValidationCheckoutPaths(candidate).some((issue) =>
        issue.startsWith(`checkout path ${path} must be`),
      ),
      `must reject a symlink at ${path}`,
    );
  }
});

test('CI checkout rejects missing and wrongly typed validation source files', () => {
  for (const [path, expectedKind] of Object.entries(REQUIRED_VALIDATION_CHECKOUT_PATHS)) {
    if (expectedKind === 'missing') continue;
    for (const kind of ['missing', expectedKind === 'file' ? 'directory' : 'file']) {
      const candidate = { ...REQUIRED_VALIDATION_CHECKOUT_PATHS, [path]: kind };
      assert.ok(
        validateValidationCheckoutPaths(candidate).some((issue) =>
          issue.startsWith(`checkout path ${path} must be ${expectedKind}`),
        ),
        `must reject ${kind} at ${path}`,
      );
    }
  }
});

test('CI checkout rejects repository npmrc, including npm script-shell overrides', () => {
  for (const kind of ['file', 'symlink', 'directory', 'other']) {
    const candidate = { ...REQUIRED_VALIDATION_CHECKOUT_PATHS, '.npmrc': kind };
    assert.match(
      validateValidationCheckoutPaths(candidate).join(' '),
      /checkout path \.npmrc must be missing/,
    );
  }
});

test('CI checkout fails closed on unavailable or incomplete path evidence', () => {
  assert.equal(
    validateValidationCheckoutPaths(undefined).length,
    Object.keys(REQUIRED_VALIDATION_CHECKOUT_PATHS).length,
  );
  const candidate = { ...REQUIRED_VALIDATION_CHECKOUT_PATHS };
  delete candidate['package-lock.json'];
  assert.match(
    validateValidationCheckoutPaths(candidate).join(' '),
    /checkout path package-lock.json must be file/,
  );
});
