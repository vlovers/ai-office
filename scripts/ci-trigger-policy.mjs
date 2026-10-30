// Fail-closed guard for the security-critical subset of validation.yml.
// An inert string or a commented-out command is not evidence of an executed gate.
const indentOf = (line) => line.match(/^ */)[0].length;
const normalize = (source) =>
  source
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !/^\s*#/.test(line));

function section(lines, key, indent, fail) {
  const prefix = ' '.repeat(indent);
  const matches = lines.flatMap((line, index) => (line === prefix + key + ':' ? [index] : []));
  if (matches.length !== 1) {
    fail('expected exactly one ' + key + ' section at indentation ' + indent);
    return [];
  }
  const start = matches[0];
  let end = start + 1;
  while (end < lines.length && indentOf(lines[end]) > indent) end++;
  return lines.slice(start + 1, end);
}

function namedEntries(lines, indent) {
  return lines.filter((line) => indentOf(line) === indent).map((line) => line.trim());
}

function jobSteps(job, fail) {
  const steps = section(job, 'steps', 4, fail);
  const starts = steps.flatMap((line, index) =>
    indentOf(line) === 6 && /^      - [a-zA-Z][\w-]*:/.test(line) ? [index] : [],
  );
  if (starts.length === 0) fail('missing job steps');
  for (const line of steps) {
    if (indentOf(line) === 6 && /^      - /.test(line) && !/^      - [a-zA-Z][\w-]*:/.test(line)) {
      fail('unrecognized validation step declaration');
    }
  }
  return starts.map((start, i) => {
    const lines = steps.slice(start, starts[i + 1] ?? steps.length);
    const runKeys = lines.filter((line, index) =>
      index === 0 ? /^      - run:/.test(line) : /^        run:/.test(line),
    );
    if (runKeys.length > 1) fail('duplicate run keys in validation step');
    const inlineRun = /^      - run:\s*(.*)$/.exec(lines[0]);
    const runIndex = lines.findIndex((line) => /^        run:/.test(line));
    const run = inlineRun
      ? inlineRun[1].trim()
      : runIndex < 0
        ? null
        : lines[runIndex].slice(12).trim();
    const commands =
      run === '|' || run === '>'
        ? lines
            .slice(inlineRun ? 1 : runIndex + 1)
            .filter((line) => indentOf(line) > 8)
            .map((line) => line.trim())
        : run === null
          ? []
          : [run];
    const uses = lines
      .map((line, index) =>
        index === 0
          ? /^      - uses:\s*(.*)$/.exec(line)?.[1]
          : /^        uses:\s*(.*)$/.exec(line)?.[1],
      )
      .filter((value) => value !== undefined);
    if (uses.length > 1) fail('duplicate uses keys in validation step');
    return {
      commands,
      uses,
      scalarRun: run === '|' || run === '>' ? null : run,
      conditional: lines.some((line) => /^        if:/.test(line)),
      allowFailure: lines.some((line) => /^        continue-on-error:/.test(line)),
    };
  });
}

// Pin the complete executable CI surface: extra steps, shell/env/defaults changes,
// artifact paths and action inputs require an explicit policy review.
const approvedValidationStructure = {
  top: ['name: AI Office validation', 'on:', 'permissions:', 'concurrency:', 'jobs:'],
  push: ['    branches: [main]'],
  concurrency: [
    '  group: ai-office-validation-${{ github.workflow }}-${{ github.ref }}',
    '  cancel-in-progress: true',
  ],
  jobs: {
    checks: {
      header: [
        'name: TypeScript, tests, smoke, build and formatting',
        'runs-on: ubuntu-latest',
        'timeout-minutes: 20',
        'steps:',
      ],
      blocks: [
        '- name: Checkout\nuses: actions/checkout@v7',
        "- name: Set up Node.js\nuses: actions/setup-node@v7\nwith:\n  node-version: '24'\n  cache: npm",
        '- name: Install dependencies\nrun: npm ci',
        '- name: TypeScript\nrun: npm run typecheck',
        '- name: Delivery security lint\nrun: npm run lint',
        '- name: Unit and integration tests\nrun: npm test',
        '- name: Offline integration stack audit regressions\nrun: node --test tests/pr-stack-audit.node.mjs',
        '- name: CI trigger and security policy regressions\nrun: node --test tests/ci-trigger-policy.node.mjs',
        '- name: HTTP/SSE smoke tests\nrun: npm run test:smoke',
        '- name: Production build\nrun: npm run build',
        '- name: Formatting\nid: formatting\nrun: npm run format:check',
        "- name: Show formatting diff on failure\nif: failure() && steps.formatting.outcome == 'failure'\nrun: |\n  npx prettier --write . > /dev/null\n  git diff -- .",
        '- name: Install Chromium and browser dependencies\nrun: npx playwright install --with-deps chromium',
        '- name: Browser smoke (deterministic fixtures)\nrun: npm run test:browser',
        '- name: Office V4 scene and state browser smoke (no model calls)\nrun: npm run test:browser:office\nenv:\n  AI_OFFICE_BROWSER_ARTIFACTS: ${{ runner.temp }}/office-v4',
        '- name: Upload office screenshots\nif: always()\nuses: actions/upload-artifact@v7\nwith:\n  name: office-v4-browser\n  path: ${{ runner.temp }}/office-v4\n  if-no-files-found: ignore\n  retention-days: 7',
        '- name: Isolated write browser smoke (no model calls)\nrun: npm run test:browser:write',
        '- name: Agent Studio browser and restart smoke (no model calls)\nrun: npm run test:browser:studio',
      ],
    },
    'native-sandbox': {
      header: [
        'name: Native Codex filesystem policy (no inference)',
        'runs-on: macos-latest',
        'timeout-minutes: 10',
        'steps:',
      ],
      blocks: [
        '- name: Checkout\nuses: actions/checkout@v7',
        "- name: Set up Node.js\nuses: actions/setup-node@v7\nwith:\n  node-version: '24'\n  cache: npm",
        '- name: Install dependencies\nrun: npm ci',
        '- name: Native read-only and isolated-write policy\nrun: npm run test:sandbox',
        '- name: Reviewer, QA, workflow recovery and security integration (native sandbox, no inference)\nrun: npm run test:workflow:native',
        '- name: Build production dashboard\nrun: npm run build',
        '- name: Install Chromium\nrun: npx playwright install chromium',
        '- name: Coder to Reviewer to QA browser approval journey (native sandbox, no inference)\nrun: npm run test:browser:workflow\nenv:\n  AI_OFFICE_BROWSER_ARTIFACTS: ${{ runner.temp }}/workflow-browser',
        '- name: Upload workflow browser evidence\nif: always()\nuses: actions/upload-artifact@v7\nwith:\n  name: workflow-browser\n  path: ${{ runner.temp }}/workflow-browser\n  if-no-files-found: ignore\n  retention-days: 7',
      ],
    },
  },
};

function validateApprovedStructure(lines, fail) {
  const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);
  const top = lines.filter((line) => indentOf(line) === 0);
  if (!same(top, approvedValidationStructure.top)) {
    fail('unreviewed top-level validation configuration');
  }
  const events = section(lines, 'on', 0, fail);
  if (!same(section(events, 'push', 2, fail), approvedValidationStructure.push)) {
    fail('push must target main only');
  }
  if (section(events, 'workflow_dispatch', 2, fail).length) {
    fail('workflow_dispatch must not accept unreviewed inputs');
  }
  if (!same(section(lines, 'concurrency', 0, fail), approvedValidationStructure.concurrency)) {
    fail('unreviewed workflow concurrency policy');
  }
  const jobs = section(lines, 'jobs', 0, fail);
  for (const [name, approved] of Object.entries(approvedValidationStructure.jobs)) {
    const job = section(jobs, name, 2, fail);
    const header = job.filter((line) => indentOf(line) === 4).map((line) => line.trim());
    if (!same(header, approved.header)) {
      fail(name + ' has unreviewed job settings');
    }
    const stepLines = section(job, 'steps', 4, fail);
    const starts = stepLines.flatMap((line, index) =>
      indentOf(line) === 6 && line.startsWith('      - ') ? [index] : [],
    );
    const blocks = starts.map((start, index) =>
      stepLines
        .slice(start, starts[index + 1] ?? stepLines.length)
        .map((line, offset) => line.slice(offset === 0 ? 6 : 8))
        .join('\n'),
    );
    if (blocks.length !== approved.blocks.length) {
      fail(name + ' has unreviewed validation step count');
    }
    for (let index = 0; index < blocks.length; index++) {
      if (blocks[index] !== approved.blocks[index]) {
        fail(name + ' has unreviewed validation step at index ' + index);
      }
    }
  }
}

export function validateValidationWorkflow(source) {
  const issues = [];
  const fail = (reason) => issues.push(reason);
  if (/^\s*\t/m.test(source)) fail('tabs are not permitted in workflow indentation');
  const lines = normalize(source);
  const events = section(lines, 'on', 0, fail);
  const eventNames = namedEntries(events, 2);
  for (const required of ['pull_request:', 'push:', 'workflow_dispatch:']) {
    if (eventNames.filter((name) => name === required).length !== 1) {
      fail('missing ' + required + ' trigger or duplicated event');
    }
  }
  for (const name of eventNames) {
    if (!['pull_request:', 'push:', 'workflow_dispatch:'].includes(name)) {
      fail('unexpected workflow trigger: ' + name);
    }
  }
  const pull = section(events, 'pull_request', 2, fail);
  if (pull.length) fail('pull_request trigger must cover all branches and default activity types');
  const permissions = section(lines, 'permissions', 0, fail);
  if (namedEntries(permissions, 2).join('\n') !== 'contents: read' || permissions.length !== 1) {
    fail('workflow permissions must be read-only: exactly contents: read');
  }
  if (/\$\{\{\s*secrets(?:\.|\[)/i.test(source)) {
    fail('validation must not reference repository or organization secrets');
  }
  const jobs = section(lines, 'jobs', 0, fail);
  const jobNames = namedEntries(jobs, 2);
  if (
    jobNames.length !== 2 ||
    jobNames.some((name) => !['checks:', 'native-sandbox:'].includes(name))
  ) {
    fail('unexpected validation job; update the security policy before adding jobs');
  }
  for (const [jobName, runner, requiredCommands] of [
    [
      'checks',
      'ubuntu-latest',
      [
        'node --test tests/pr-stack-audit.node.mjs',
        'node --test tests/ci-trigger-policy.node.mjs',
        'npm run typecheck',
        'npm run lint',
        'npm test',
        'npm run test:smoke',
        'npm run build',
        'npm run format:check',
        'npm run test:browser',
        'npm run test:browser:office',
        'npm run test:browser:write',
        'npm run test:browser:studio',
      ],
    ],
    [
      'native-sandbox',
      'macos-latest',
      ['npm run test:sandbox', 'npm run test:workflow:native', 'npm run test:browser:workflow'],
    ],
  ]) {
    const job = section(jobs, jobName, 2, fail);
    if (!job.some((line) => line === '    runs-on: ' + runner)) {
      fail(jobName + ' must run on ' + runner);
    }
    if (job.some((line) => /^    (?:permissions|if|continue-on-error):/.test(line))) {
      fail(jobName + ' must not override permissions, skip execution or allow failure');
    }
    const steps = jobSteps(job, fail);
    for (const command of requiredCommands) {
      const matches = steps.filter((step) => step.scalarRun === command);
      if (matches.length !== 1) {
        fail(jobName + ' missing validation step or duplicate: ' + command);
      } else if (matches[0].conditional || matches[0].allowFailure) {
        fail(
          jobName + ' required validation step cannot be conditional or allow failure: ' + command,
        );
      }
    }
    for (const step of steps) {
      if (
        step.uses.some(
          (action) =>
            ![
              'actions/checkout@v7',
              'actions/setup-node@v7',
              'actions/upload-artifact@v7',
            ].includes(action),
        )
      ) {
        fail(jobName + ' uses an unreviewed GitHub Action');
      }
      if (
        step.commands.some((command) =>
          /\b(?:test:real(?:\b|:)|test:dashboard:real\b|test:real:workflow\b|--run\s+(?:real|provider))/.test(
            command,
          ),
        )
      ) {
        fail(jobName + ' must not call real providers');
      }
    }
  }
  validateApprovedStructure(lines, fail);
  return issues;
}
