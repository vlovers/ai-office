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
  const matches = lines.flatMap((line, index) =>
    line === prefix + key + ':' ? [index] : [],
  );
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
  return lines
    .filter((line) => indentOf(line) === indent)
    .map((line) => line.trim());
}

function jobSteps(job, fail) {
  const steps = section(job, 'steps', 4, fail);
  const starts = steps.flatMap((line, index) =>
    indentOf(line) === 6 && /^      - (?:name|run|uses):/.test(line) ? [index] : [],
  );
  if (starts.length === 0) fail('missing job steps');
  return starts.map((start, i) => {
    const lines = steps.slice(start, starts[i + 1] ?? steps.length);
    const runIndex = lines.findIndex((line) => /^        run:/.test(line));
    const run = runIndex < 0 ? null : lines[runIndex].slice(12).trim();
    const commands =
      run === '|' || run === '>'
        ? lines
            .slice(runIndex + 1)
            .filter((line) => indentOf(line) > 8)
            .map((line) => line.trim())
        : run === null
          ? []
          : [run];
    return {
      commands,
      scalarRun: run === '|' || run === '>' ? null : run,
      conditional: lines.some((line) => /^        if:/.test(line)),
      allowFailure: lines.some((line) => /^        continue-on-error:/.test(line)),
    };
  });
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
  const jobs = section(lines, 'jobs', 0, fail);
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
        fail(jobName + ' required validation step cannot be conditional or allow failure: ' + command);
      }
    }
    for (const step of steps) {
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
  return issues;
}
