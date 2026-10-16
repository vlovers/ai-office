// Test double for the CLI transport, consumed through the REAL installed Codex SDK.
// Never invokes a model, accesses auth, or executes model-generated commands.
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
const args = process.argv.slice(2);
const config = args.filter((_, index) => args[index - 1] === '--config');
const filesystem = config.find((arg) => arg.startsWith('permissions.ai-office-review.filesystem='));
if (
  args.includes('--sandbox') ||
  args.includes('--add-dir') ||
  args.includes('--skip-git-repo-check') ||
  config.some(
    (arg) => arg.includes('danger-full-access') || arg.includes('approval_policy="never"'),
  )
)
  throw new Error('Unsafe SDK options');
if (!args.includes('--ignore-user-config') || !args.includes('--ignore-rules'))
  throw new Error('Uncontrolled CLI configuration');
if (
  !filesystem?.includes('":root"="deny"') ||
  !filesystem.includes('"."="read"') ||
  !config.includes('permissions.ai-office-review.network.enabled=false') ||
  !config.includes('approval_policy="on-request"')
)
  throw new Error('Restrictive profile missing');
const repo = args[args.indexOf('--cd') + 1];
if (!repo || !existsSync(repo + '/.git')) throw new Error('Disposable Git worktree required');
if (
  process.env.HOME !== process.env.CODEX_HOME ||
  process.env.AI_OFFICE_TEST_SECRET ||
  process.env.OPENAI_API_KEY
)
  throw new Error('Host environment leaked');
let input = '';
for await (const chunk of process.stdin) input += chunk;
const send = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const savedThread = args.find((arg) => /^00000000-0000-4000-8000-[a-f0-9]{12}$/.test(arg));
const threadId =
  savedThread ??
  `00000000-0000-4000-8000-${createHash('sha256').update(repo).digest('hex').slice(0, 12)}`;
send({ type: 'thread.started', thread_id: threadId });
send({ type: 'turn.started' });
if (input.includes('AUTH_FIXTURE')) {
  send({
    type: 'turn.failed',
    error: { message: '401 unauthorized: expired login AUTH_SECRET_SYNTHETIC' },
  });
  process.exit(1);
}
if (input.includes('FAIL_FIXTURE')) {
  send({ type: 'turn.failed', error: { message: 'Simulated provider failure' } });
  process.exit(1);
}
if (input.includes('EXIT_FIXTURE')) process.exit(7);
if (input.includes('WAIT_FIXTURE')) {
  // Ignore graceful termination to exercise supervisor process-group escalation.
  process.on('SIGTERM', () => {});
  setInterval(
    () =>
      send({
        type: 'item.updated',
        item: { id: 'wait', type: 'reasoning', text: 'Waiting for Stop…' },
      }),
    100,
  );
} else {
  send({
    type: 'item.completed',
    item: {
      id: 'commentary',
      type: 'agent_message',
      text: 'Interim commentary: I will inspect the repository.',
    },
  });
  send({
    type: 'item.started',
    item: { id: 'review', type: 'reasoning', text: 'Inspecting the disposable repository.' },
  });
  const resumed = args.includes('resume');
  send({
    type: 'item.completed',
    item: {
      id: 'result',
      type: 'agent_message',
      text: resumed
        ? 'Resumed the saved review thread.'
        : 'Reviewed the disposable repository. README.md is present. No files were modified.',
    },
  });
  send({
    type: 'turn.completed',
    usage: {
      input_tokens: 10,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 12,
      reasoning_output_tokens: 0,
    },
  });
}
