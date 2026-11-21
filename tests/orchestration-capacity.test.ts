import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { realpath } from 'node:fs/promises';
import { sandbox, until } from './helpers.js';
import { validateRepository } from '../src/server/repositories.js';
import { TaskManager } from '../src/server/manager.js';
import { Workspaces } from '../src/server/workspaces.js';
import { CodexProvider } from '../src/server/providers/codex.js';
import { OrchestrationStore } from '../src/server/orchestration.js';
import { WorkflowStore } from '../src/server/workflows.js';
import { createApp } from '../src/server/app.js';
import type { Proposal, Plan } from '../src/shared/orchestration.js';

it('runs at most two approved plan workflows and keeps a third queued until a slot is released (SDK fixture)', async () => {
  const peers = await Promise.all([sandbox(), sandbox(), sandbox()]);
  const env = peers[0]!;
  const workspaces = new Workspaces({
    authorizedRoot: await realpath(tmpdir()),
    workspaceRoot: join(env.root, 'worktrees'),
    commands: {},
    verificationTimeoutMs: 1000,
    allowHostVerification: false,
  });
  const manager = new TaskManager(
    env.store,
    env.providers,
    env.auth,
    undefined,
    undefined,
    workspaces,
    {
      concurrency: 2,
      createProvider: (id) =>
        new CodexProvider({ home: join(env.root, 'workers', id), auth: env.auth }),
    },
  );
  const app = await createApp(manager);
  try {
    const reviewer = env.store.agent('codex-2')!;
    env.store.editAgent(reviewer.id, reviewer.revision, { ...reviewer, maximumMode: 'read-only' });
    const profiles = ['A', 'B', 'C'].map((name) =>
      env.store.createAgent({
        name: `Fixture Coder ${name}`,
        role: 'Coder',
        description: 'Deterministic SDK fixture',
        instructions: '',
        model: 'fixture-model',
        maximumMode: 'write',
      }),
    );
    const store = new OrchestrationStore(env.store);
    const workflows = new WorkflowStore(env.store.db);
    const plans: Plan[] = [];
    const tasks: string[] = [];
    for (const [index, peer] of peers.entries()) {
      execFileSync('/usr/bin/git', ['-C', peer.repository, 'add', '.']);
      execFileSync('/usr/bin/git', [
        '-C',
        peer.repository,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        'fixture baseline',
      ]);
      const repo = env.store.register(await validateRepository(peer.repository));
      const proposal: Proposal = {
        title: `Capacity fixture ${index}`,
        prompt: 'WAIT_FIXTURE',
        stages: [
          {
            kind: 'coder',
            agentId: profiles[index]!.id,
            dependsOn: [],
            entryCondition: 'operator_approval',
            estimateMinutes: null,
          },
          {
            kind: 'reviewer',
            agentId: 'codex-2',
            dependsOn: ['coder'],
            entryCondition: 'approved_coder_evidence',
            estimateMinutes: null,
          },
        ],
        constraints: { maxWorkers: 2, estimatedMinutesBudget: null },
        includeContext: false,
      };
      const draft = store.createPlan(repo.id, proposal);
      const send = (url: string, payload: Record<string, unknown>) =>
        app.inject({
          method: 'POST',
          url,
          headers: { host: '127.0.0.1:4310', 'content-type': 'application/json' },
          payload,
        });
      const response = await send(`/api/repositories/${repo.id}/plans/${draft.id}/run`, {
        version: 0,
        contextRevision: 0,
        confirmed: true,
      });
      expect(response.statusCode).toBe(201);
      const plan = store.plan(repo.id, draft.id);
      plans.push(plan);
      const workflow = workflows.get(plan.workflowId!)!;
      const taskId = workflow.stages[0]!.taskId!;
      tasks.push(taskId);
      expect(
        (
          await send(`/api/workflows/${workflow.id}/approve-initial`, {
            version: 0,
            confirmed: true,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await send(`/api/workflows/${workflow.id}/submit-initial`, {
            version: 1,
            confirmed: true,
            confirmedWrite: true,
          })
        ).statusCode,
      ).toBe(202);
    }
    await until(
      () => tasks.slice(0, 2).map((id) => env.store.task(id)!.state),
      (states) => states.every((state) => state === 'running'),
      20000,
    );
    expect(manager.dashboard().concurrency).toBe(2);
    expect(
      manager.dashboard().agents.filter((agent) => ['running', 'preparing'].includes(agent.state)),
    ).toHaveLength(2);
    expect(env.store.task(tasks[2]!)!.state).toBe('queued');
    expect(store.run(plans[2]!).state).toBe('queued');
    await manager.stop(tasks[0]!);
    await until(
      () => env.store.task(tasks[2]!)!.state,
      (state) => state === 'running',
      20000,
    );
    expect(env.store.tasks().filter((task) => task.state === 'running')).toHaveLength(2);
    await Promise.all(tasks.slice(1).map((id) => manager.stop(id)));
    expect(env.store.tasks().every((task) => task.state === 'stopped')).toBe(true);
    expect(plans.map((plan) => store.run(plan).state)).toEqual(['stopped', 'stopped', 'stopped']);
  } finally {
    await app.close();
    for (const peer of peers) await peer.cleanup();
  }
}, 60000);
