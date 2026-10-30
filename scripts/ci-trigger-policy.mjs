// Read-only static guard for GitHub Actions trigger and execution policy.
// GitHub evaluates pull_request filters on the BASE branch. Filtering to
// main/test/fix silently drops checks for security or future stacked branches.
export function validateValidationWorkflow(source) {
  const issues = [];
  const fail = (reason) => issues.push(reason);
  const events = source.match(/^on:\s*\n([\s\S]*?)(?=^[^\s#]|$(?![\s\S]))/m)?.[1];
  if (!events || !/^  pull_request:\s*(?:#.*)?$/m.test(events)) {
    fail('missing pull_request trigger');
  } else {
    const block = events.split(/^  pull_request:\s*(?:#.*)?$/m)[1]?.split(/^  [a-z_-]+:/m)[0] ?? '';
    if (/^    (?:branches|branches-ignore|paths|paths-ignore|types):/m.test(block)) {
      fail('pull_request trigger must cover all branches and default activity types');
    }
  }
  if (events && /^  pull_request_target:/m.test(events)) {
    fail('pull_request_target is unsafe for untrusted PR code');
  }
  if (!/^permissions:\s*\n  contents: read\s*$/m.test(source)) {
    fail('workflow permissions must be explicitly read-only');
  }
  if (/^  [a-z_-]+: write\s*$/m.test(source)) {
    fail('workflow must not grant write permissions');
  }
  for (const required of [
    'node --test tests/pr-stack-audit.node.mjs',
    'node --test tests/ci-trigger-policy.node.mjs',
    'npm run typecheck',
    'npm test',
    'npm run test:sandbox',
    'npm run test:workflow:native',
    'npm run test:browser:workflow',
    'npm run format:check',
  ]) {
    if (!source.includes(required)) fail('missing validation step: ' + required);
  }
  if (/npm run test:real(?:\b|:)|--run\s+(?:real|provider)/.test(source)) {
    fail('validation must not call real providers');
  }
  return issues;
}
