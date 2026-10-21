import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TaskManager } from './manager.js';
import { agentIdSchema, agentSettingsSchema } from './agents.js';
import { AppError } from './errors.js';
import { WorkflowStore } from './workflows.js';
import { workflowTimeline } from './workflow-timeline.js';
import { assessHandoff } from './handoff-assessment.js';
import { git, revalidateRepository, validateRepository } from './repositories.js';
import type { AgentEvent, WorkspaceReview } from '../shared/types.js';

const id = z.string().uuid();
export async function createApp(manager: TaskManager) {
  const app = Fastify({
    logger: false,
    bodyLimit: 24 * 1024,
    requestTimeout: 10_000,
    forceCloseConnections: true,
  });
  const streams = new Set<import('node:http').ServerResponse>();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: 'Invalid request fields.',
        details: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.code}`),
      });
    const known = error instanceof AppError;
    const status = known
      ? error.statusCode
      : ((error as { statusCode?: number }).statusCode ?? 500);
    return reply.code(status).send({
      error: known ? error.message : status === 500 ? 'Internal server error.' : 'Invalid request.',
    });
  });
  app.addHook('onRequest', async (request, reply) => {
    // Host validation prevents DNS rebinding; same-origin checks prevent drive-by mutations.
    const address = app.server.address();
    const port = address && typeof address !== 'string' ? address.port : 4310;
    const hosts = [`127.0.0.1:${port}`, '127.0.0.1:5173'];
    if (!hosts.includes(request.headers.host ?? ''))
      return reply.code(403).send({ error: 'Use the 127.0.0.1 local URL.' });
    const origin = request.headers.origin;
    if (origin && !hosts.map((host) => `http://${host}`).includes(origin))
      return reply.code(403).send({ error: 'Cross-origin access is forbidden.' });
    if (request.headers['sec-fetch-site'] === 'cross-site')
      return reply.code(403).send({ error: 'Cross-site access is forbidden.' });
    if (
      !['GET', 'HEAD'].includes(request.method) &&
      !request.headers['content-type']?.startsWith('application/json')
    )
      return reply.code(415).send({ error: 'Requests must use application/json.' });
    reply.header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-store');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
  });
  app.addHook('onListen', async () => {
    manager.startQueue();
  });
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/dashboard', async () => manager.dashboard());
  // Workflow creation persists only inert stage definitions; executable mutation
  // actions remain disabled until TaskManager enforces approvals and leases.
  app.post('/api/workflows', async (request, reply) => {
    const input = z
      .object({
        repositoryId: id,
        coderAgentId: agentIdSchema,
        reviewerAgentId: agentIdSchema,
        qaAgentId: agentIdSchema.optional(),
      })
      .strict()
      .parse(request.body);
    const repository = manager.store.repository(input.repositoryId);
    if (!repository) throw new AppError(404, 'Repository not found.');
    await revalidateRepository(repository);
    // Use the server-observed HEAD, not a browser-supplied revision.
    const revision = (await git(repository.path, ['rev-parse', '--verify', 'HEAD'])).trim();
    if (!/^[0-9a-f]{40,64}$/i.test(revision))
      throw new AppError(409, 'Repository has no verifiable Git HEAD.');
    const profiles = [
      { kind: 'coder' as const, id: input.coderAgentId, mode: 'write' as const },
      { kind: 'reviewer' as const, id: input.reviewerAgentId, mode: 'read-only' as const },
      ...(input.qaAgentId
        ? [{ kind: 'qa' as const, id: input.qaAgentId, mode: 'read-only' as const }]
        : []),
    ];
    const stages = profiles.map((profile) => {
      const agent = manager.store.requireAgent(profile.id);
      if (agent.archived)
        throw new AppError(409, 'Restore archived agent before creating workflow.');
      return {
        kind: profile.kind,
        agentId: agent.id,
        agentRevision: agent.revision,
        mode: profile.mode,
      };
    });
    return reply.code(201).send(
      new WorkflowStore(manager.store.db).create({
        repositoryId: repository.id,
        baselineRevision: revision,
        stages,
      }),
    );
  });
  app.post('/api/workflows/:id/approve-initial', async (request) => {
    const workflowId = id.parse((request.params as { id: string }).id);
    const input = z
      .object({
        version: z.number().int().nonnegative(),
        confirmed: z.literal(true),
      })
      .strict()
      .parse(request.body);
    const workflows = new WorkflowStore(manager.store.db);
    const workflow = workflows.get(workflowId);
    if (!workflow) throw new AppError(404, 'Workflow not found.');
    if (workflow.state !== 'active' || workflow.stages[0]?.state !== 'awaiting_approval')
      throw new AppError(409, 'Initial stage is not awaiting approval.');
    const repository = manager.store.repository(workflow.repositoryId);
    if (!repository) throw new AppError(409, 'Workflow repository no longer exists.');
    await revalidateRepository(repository);
    const head = (await git(repository.path, ['rev-parse', '--verify', 'HEAD'])).trim();
    if (head !== workflow.baselineRevision)
      throw new AppError(409, 'Repository revision changed. Approval denied.');
    const changes = await git(repository.path, [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ]);
    if (changes.trim())
      throw new AppError(409, 'Repository has uncommitted changes. Approval denied.');
    // This only changes durable state. It never submits a task or grants write authority.
    return workflows.transition(workflowId, input.version, {
      type: 'approve',
      revision: head,
    });
  });
  app.post('/api/workflows/:id/bind-task', async (request) => {
    const workflowId = id.parse((request.params as { id: string }).id);
    const input = z
      .object({
        version: z.number().int().nonnegative(),
        taskId: id,
        confirmed: z.literal(true),
      })
      .strict()
      .parse(request.body);
    const workflows = new WorkflowStore(manager.store.db);
    const workflow = workflows.get(workflowId);
    if (!workflow) throw new AppError(404, 'Workflow not found.');
    if (
      workflow.state !== 'active' ||
      workflow.stages[0]?.state !== 'ready' ||
      workflow.stages[0]?.taskId !== null
    )
      throw new AppError(409, 'Initial stage is not available for task binding.');
    const repository = manager.store.repository(workflow.repositoryId);
    if (!repository) throw new AppError(409, 'Repository no longer exists.');
    await revalidateRepository(repository);
    const head = (await git(repository.path, ['rev-parse', '--verify', 'HEAD'])).trim();
    if (head !== workflow.stages[0].approvedRevision)
      throw new AppError(409, 'Approved Git revision is stale.');
    const changes = await git(repository.path, [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ]);
    if (changes.trim()) throw new AppError(409, 'Repository has uncommitted changes.');
    // Task binding is inert: TaskManager alone owns queue submission and writes.
    return workflows.bindApprovedTask(workflowId, input.version, input.taskId);
  });
  app.post('/api/workflows/:id/submit-initial', async (request, reply) => {
    const workflowId = id.parse((request.params as { id: string }).id);
    const input = z
      .object({
        version: z.number().int().nonnegative(),
        confirmed: z.literal(true),
        confirmedWrite: z.literal(true),
      })
      .strict()
      .parse(request.body);
    const workflow = new WorkflowStore(manager.store.db).get(workflowId);
    if (!workflow) throw new AppError(404, 'Workflow not found.');
    const stage = workflow.stages[0];
    if (
      workflow.state !== 'active' ||
      stage?.state !== 'ready' ||
      !stage.taskId ||
      !stage.approvedRevision ||
      workflow.version !== input.version
    )
      throw new AppError(409, 'Initial workflow stage is not ready.');
    const repository = manager.store.repository(workflow.repositoryId);
    if (!repository) throw new AppError(409, 'Workflow repository missing.');
    await revalidateRepository(repository);
    const head = (await git(repository.path, ['rev-parse', '--verify', 'HEAD'])).trim();
    if (head !== stage.approvedRevision) throw new AppError(409, 'Approved Git revision is stale.');
    const changes = await git(repository.path, [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ]);
    if (changes.trim()) throw new AppError(409, 'Repository has uncommitted changes.');
    const submitted = manager.start(stage.taskId, undefined, true, {
      id: workflowId,
      version: input.version,
      revision: head,
    });
    return reply
      .code(202)
      .send({ task: submitted, workflow: new WorkflowStore(manager.store.db).get(workflowId) });
  });
  app.post('/api/workflows/:id/capture-coder-evidence', async (request) => {
    const workflowId = id.parse((request.params as { id: string }).id);
    const input = z
      .object({
        version: z.number().int().nonnegative(),
        confirmed: z.literal(true),
        replace: z.literal(true).optional(),
      })
      .strict()
      .parse(request.body);
    const workflows = new WorkflowStore(manager.store.db);
    const workflow = workflows.get(workflowId);
    const coder = workflow?.stages[0];
    if (
      !workflow ||
      !coder?.taskId ||
      workflow.version !== input.version ||
      workflow.state !== 'blocked' ||
      coder.state !== 'blocked' ||
      (input.replace ? !coder.evidence : Boolean(coder.evidence))
    )
      throw new AppError(409, 'Coder is not awaiting evidence capture.');
    const task = manager.store.task(coder.taskId);
    if (!task || task.state !== 'completed' || !task.workspaceId)
      throw new AppError(409, 'Completed Coder workspace missing.');
    // Reuse Review Center's worktree identity, lease and revision validation.
    const review = (await manager.reviewOperation(task.id, 'review')) as WorkspaceReview;
    if (!review.revision || review.workspace.id !== task.workspaceId)
      throw new AppError(409, 'Review Center did not return a verified revision.');
    return workflows.captureCoderEvidence(
      workflowId,
      input.version,
      {
        taskId: task.id,
        workspaceId: review.workspace.id,
        revision: review.revision,
        fileCount: review.files.length,
      },
      input.replace === true,
    );
  });
  app.post('/api/workflows/:id/approve-coder-evidence', async (request) => {
    const workflowId = id.parse((request.params as { id: string }).id);
    const input = z
      .object({
        version: z.number().int().nonnegative(),
        confirmed: z.literal(true),
        revision: z.string().regex(/^[0-9a-f]{64}$/i),
      })
      .strict()
      .parse(request.body);
    const workflows = new WorkflowStore(manager.store.db);
    const workflow = workflows.get(workflowId);
    const coder = workflow?.stages[0];
    if (
      !workflow ||
      !coder?.taskId ||
      !coder.evidence ||
      coder.evidence.revision !== input.revision
    )
      throw new AppError(409, 'No matching Coder evidence exists.');
    const task = manager.store.task(coder.taskId);
    if (!task || task.workspaceId !== coder.evidence.workspaceId)
      throw new AppError(409, 'Coder workspace ownership changed.');
    // Acquire the same repository lease and re-hash the exact worktree
    // through Review Center; never trust the revision sent by the client.
    const fresh = (await manager.reviewOperation(task.id, 'review')) as WorkspaceReview;
    if (
      fresh.revision !== coder.evidence.revision ||
      fresh.workspace.id !== coder.evidence.workspaceId ||
      fresh.files.length !== coder.evidence.fileCount
    )
      throw new AppError(409, 'Coder output changed. Capture fresh evidence before approval.');
    return workflows.approveCoderEvidence(workflowId, input.version, task.id, fresh.revision);
  });
  app.post('/api/workflows/:id/approve-reviewer', async (request) => {
    const workflowId = id.parse((request.params as { id: string }).id);
    const input = z
      .object({
        version: z.number().int().nonnegative(),
        revision: z.string().regex(/^[0-9a-f]{64}$/i),
        confirmed: z.literal(true),
      })
      .strict()
      .parse(request.body);
    const workflows = new WorkflowStore(manager.store.db);
    const workflow = workflows.get(workflowId);
    const coder = workflow?.stages[0];
    const reviewer = workflow?.stages[1];
    if (
      !workflow ||
      workflow.state !== 'active' ||
      coder?.state !== 'completed' ||
      !coder.taskId ||
      !coder.evidence ||
      reviewer?.state !== 'awaiting_approval' ||
      workflow.version !== input.version ||
      input.revision !== coder.evidence.revision
    )
      throw new AppError(409, 'Reviewer handoff is stale or not available.');
    const task = manager.store.task(coder.taskId);
    if (!task || task.workspaceId !== coder.evidence.workspaceId)
      throw new AppError(409, 'Coder workspace is no longer bound.');
    // Revalidate Review Center's content fingerprint while holding its lease.
    const review = (await manager.reviewOperation(task.id, 'review')) as WorkspaceReview;
    if (
      review.revision !== coder.evidence.revision ||
      review.workspace.id !== coder.evidence.workspaceId ||
      review.files.length !== coder.evidence.fileCount
    )
      throw new AppError(409, 'Coder content changed. Reviewer handoff denied.');
    // Approval only, not a model run. A verified read-only workspace runner
    // is required before allowing Reviewer to be submitted.
    return workflows.transition(workflowId, input.version, {
      type: 'approve',
      revision: review.revision,
    });
  });
  app.post('/api/workflows/:id/capture-bundle', async (request) => {
    const workflowId = id.parse((request.params as { id: string }).id);
    const input = z
      .object({
        version: z.number().int().nonnegative(),
        revision: z.string().regex(/^[0-9a-f]{64}$/i),
        confirmed: z.literal(true),
      })
      .strict()
      .parse(request.body);
    return manager.captureWorkflowBundle(workflowId, input.version, input.revision);
  });
  app.get('/api/workflows/bundles/audit', async () => manager.auditWorkflowBundles());
  app.post('/api/workflows/:id/prepare-reviewer-runtime', async (request) => {
    const workflowId = id.parse((request.params as { id: string }).id);
    const input = z
      .object({ version: z.number().int().nonnegative(), confirmed: z.literal(true) })
      .strict()
      .parse(request.body);
    return manager.prepareReviewerRuntime(workflowId, input.version);
  });
  app.post('/api/workflows/:id/verify-reviewer-source', async (request) => {
    const workflowId = id.parse((request.params as { id: string }).id);
    const input = z
      .object({ version: z.number().int().nonnegative() })
      .strict()
      .parse(request.body);
    return manager.verifyPreparedReviewerSource(workflowId, input.version);
  });
  app.post('/api/workflows/:id/prepare-reviewer-source', async (request) => {
    const workflowId = id.parse((request.params as { id: string }).id);
    const input = z
      .object({ version: z.number().int().nonnegative(), confirmed: z.literal(true) })
      .strict()
      .parse(request.body);
    return manager.prepareReviewerSource(workflowId, input.version);
  });
  app.post('/api/workflows/:id/verify-bundle', async (request) => {
    const workflowId = id.parse((request.params as { id: string }).id);
    const input = z
      .object({ version: z.number().int().nonnegative() })
      .strict()
      .parse(request.body);
    return manager.inspectWorkflowBundle(workflowId, input.version);
  });
  app.post('/api/workflows/:id/inspect-handoff', async (request) => {
    const workflowId = id.parse((request.params as { id: string }).id);
    const input = z
      .object({
        version: z.number().int().nonnegative(),
        revision: z.string().regex(/^[0-9a-f]{64}$/i),
      })
      .strict()
      .parse(request.body);
    const workflow = new WorkflowStore(manager.store.db).get(workflowId);
    const coder = workflow?.stages[0];
    const reviewer = workflow?.stages[1];
    if (
      !workflow ||
      workflow.version !== input.version ||
      workflow.state !== 'active' ||
      coder?.state !== 'completed' ||
      !coder.taskId ||
      !coder.evidence ||
      coder.evidence.revision !== input.revision ||
      reviewer?.state !== 'ready' ||
      reviewer.approvedRevision !== input.revision
    )
      throw new AppError(409, 'Reviewer handoff checkpoint is stale or unapproved.');
    const task = manager.store.task(coder.taskId);
    if (!task || task.workspaceId !== coder.evidence.workspaceId)
      throw new AppError(409, 'Coder workspace binding changed.');
    const review = (await manager.reviewOperation(task.id, 'review')) as WorkspaceReview;
    if (
      review.revision !== input.revision ||
      review.workspace.id !== coder.evidence.workspaceId ||
      review.files.length !== coder.evidence.fileCount
    )
      throw new AppError(409, 'Handoff evidence changed. Reapprove Coder output.');
    const assessment = assessHandoff(review.files);
    return {
      workflowId,
      version: workflow.version,
      revision: input.revision,
      ...assessment,
      snapshotCreated: false,
      downstreamExecutable: false,
      result: assessment.eligible ? 'snapshot-runner-required' : 'manual-inspection-required',
    };
  });
  app.get('/api/workflows', async () => new WorkflowStore(manager.store.db).list());
  app.get('/api/workflows/:id/timeline', async (request) => {
    const workflow = new WorkflowStore(manager.store.db).get(
      id.parse((request.params as { id: string }).id),
    );
    if (!workflow) throw new AppError(404, 'Workflow not found.');
    return workflowTimeline(workflow);
  });
  app.get('/api/workflows/:id', async (request) => {
    const workflow = new WorkflowStore(manager.store.db).get(
      id.parse((request.params as { id: string }).id),
    );
    if (!workflow) throw new AppError(404, 'Workflow not found.');
    return workflow;
  });
  app.post('/api/connection', async (request) => {
    const input = z
      .object({ mode: z.enum(['local-cli-chatgpt', 'api-key']) })
      .strict()
      .parse(request.body);
    return manager.selectConnection(input.mode);
  });
  app.post('/api/connection/refresh', async (request) => {
    z.object({}).strict().parse(request.body);
    return manager.refreshConnection();
  });
  app.post('/api/repositories', async (request, reply) => {
    const input = z
      .object({ path: z.string().min(1).max(4096) })
      .strict()
      .parse(request.body);
    const repo = await validateRepository(input.path);
    return reply.code(201).send(manager.store.register(repo));
  });
  app.get('/api/agents', async () => manager.store.agents());
  app.get('/api/agents/:id', async (request) =>
    manager.store.requireAgent(agentIdSchema.parse((request.params as { id: string }).id)),
  );
  app.post('/api/agents', async (request, reply) =>
    reply.code(201).send(manager.store.createAgent(manager.agentSettings(request.body))),
  );
  app.post('/api/agents/:id', async (request) => {
    const input = agentSettingsSchema
      .extend({ revision: z.number().int().positive() })
      .strict()
      .parse(request.body);
    const { revision, ...settings } = input;
    return manager.store.editAgent(
      agentIdSchema.parse((request.params as { id: string }).id),
      revision,
      manager.agentSettings(settings),
    );
  });
  app.post('/api/agents/:id/archive', async (request) => {
    const input = z
      .object({ revision: z.number().int().positive(), archived: z.boolean() })
      .strict()
      .parse(request.body);
    return manager.store.editAgent(
      agentIdSchema.parse((request.params as { id: string }).id),
      input.revision,
      { archived: input.archived },
    );
  });
  app.post('/api/agents/:id/duplicate', async (request, reply) => {
    const input = z.object({ revision: z.number().int().positive() }).strict().parse(request.body);
    const original = manager.store.requireAgent(
      agentIdSchema.parse((request.params as { id: string }).id),
      input.revision,
    );
    const { name, role, description, instructions, model, maximumMode } = original;
    return reply
      .code(201)
      .send(
        manager.store.createAgent(
          manager.agentSettings({ name, role, description, instructions, model, maximumMode }),
        ),
      );
  });
  app.post('/api/tasks', async (request, reply) => {
    const input = z
      .object({
        repositoryId: id,
        agentId: agentIdSchema,
        executionMode: z.enum(['read-only', 'write']).default('read-only'),
        title: z.string().trim().min(1).max(160),
        prompt: z.string().trim().min(1).max(16000),
      })
      .strict()
      .parse(request.body);
    if (!manager.store.repository(input.repositoryId))
      throw new AppError(404, 'Repository not found.');
    const profile = manager.store.requireAgent(input.agentId);
    if (profile.archived)
      throw new AppError(409, 'Restore the archived agent before assigning new work.');
    return reply.code(201).send(manager.store.createTask(input));
  });
  app.post('/api/tasks/:id/start', async (request, reply) => {
    const taskId = id.parse((request.params as { id: string }).id);
    const input = z
      .object({ resumeSessionId: id.optional(), confirmedWrite: z.boolean().optional() })
      .strict()
      .parse(request.body);
    return reply.code(202).send(manager.start(taskId, input.resumeSessionId, input.confirmedWrite));
  });
  app.get('/api/tasks/:id/review', async (request) =>
    manager.reviewOperation(id.parse((request.params as { id: string }).id), 'review'),
  );
  app.get('/api/tasks/:id/review/history', async (request) => {
    const query = z
      .object({
        before: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
      })
      .strict()
      .parse(request.query);
    return manager.reviewHistory(id.parse((request.params as { id: string }).id), query.before);
  });
  app.post('/api/tasks/:id/review/feedback', async (request) => {
    const input = z
      .object({
        revision: z.string().regex(/^[a-f0-9]{64}$/),
        version: z.number().int().min(0),
        comments: z
          .array(
            z
              .object({
                id,
                body: z.string().trim().min(1).max(4000),
                path: z.string().min(1).max(4096).optional(),
                anchor: z
                  .object({
                    side: z.enum(['old', 'new']),
                    line: z.number().int().positive().max(10000000),
                  })
                  .strict()
                  .optional(),
                createdAt: z.string().max(40),
                updatedAt: z.string().max(40),
              })
              .strict(),
          )
          .max(50),
      })
      .strict()
      .parse(request.body);
    if (JSON.stringify(input).length > 20000)
      throw new AppError(413, 'Feedback exceeds 20,000 characters.');
    return manager.reviewOperation(
      id.parse((request.params as { id: string }).id),
      'feedback',
      undefined,
      input.revision,
      input,
    );
  });
  app.post('/api/tasks/:id/review/request-changes', async (request) => {
    const input = z
      .object({
        revision: z.string().regex(/^[a-f0-9]{64}$/),
        version: z.number().int().min(0),
        confirmed: z.literal(true),
      })
      .strict()
      .parse(request.body);
    return manager.reviewOperation(
      id.parse((request.params as { id: string }).id),
      'request-changes',
      undefined,
      input.revision,
      { ...input, comments: [] },
    );
  });
  app.post('/api/tasks/:id/review', async (request) => {
    const input = z
      .object({
        action: z.enum(['keep', 'reject', 'verify']),
        confirmed: z.literal(true),
        command: z.string().max(160).optional(),
        revision: z.string().regex(/^[a-f0-9]{64}$/),
        confirmedHostExecution: z.boolean().optional(),
      })
      .strict()
      .parse(request.body);
    if (input.action === 'verify' && input.confirmedHostExecution !== true)
      throw new AppError(409, 'Explicit host execution confirmation is required.');
    return manager.reviewOperation(
      id.parse((request.params as { id: string }).id),
      input.action,
      input.command,
      input.revision,
    );
  });
  app.post('/api/tasks/:id/stop', async (request, reply) => {
    const taskId = id.parse((request.params as { id: string }).id);
    z.object({}).strict().parse(request.body);
    await manager.stop(taskId);
    return reply.send(manager.store.task(taskId));
  });
  app.get('/api/tasks/:id/events', async (request, reply) => {
    const taskId = id.parse((request.params as { id: string }).id);
    if (!manager.store.task(taskId)) throw new AppError(404, 'Task not found.');
    const query = z
      .object({ after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0) })
      .strict()
      .parse(request.query);
    return manager.store.events(taskId, query.after);
  });
  app.get('/api/tasks/:id/stream', (request, reply) => {
    const taskId = id.parse((request.params as { id: string }).id);
    if (!manager.store.task(taskId)) throw new AppError(404, 'Task not found.');
    const query = z
      .object({ after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0) })
      .strict()
      .parse(request.query);
    const header = request.headers['last-event-id'];
    let cursor = header
      ? z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(header)
      : query.after;
    reply.hijack();
    const response = reply.raw;
    streams.add(response);
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    const write = (event: AgentEvent) => {
      if (event.taskId !== taskId || event.id <= cursor || response.destroyed) return;
      cursor = event.id;
      if (response.writableLength > 1024 * 1024) {
        response.destroy();
        return;
      }
      response.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`); // bounded slow clients reconnect using their last parsed cursor
    };
    // Subscribe before synchronous DB replay; no event can fall into a snapshot/subscription gap.
    manager.events.on('event', write);
    let batch: AgentEvent[];
    do {
      batch = manager.store.events(taskId, cursor);
      batch.forEach(write);
    } while (batch.length === 500 && !response.destroyed);
    response.write(': connected\n\n');
    const heartbeat = setInterval(() => {
      if (!response.write(': heartbeat\n\n')) response.destroy();
    }, 15_000);
    response.on('close', () => {
      clearInterval(heartbeat);
      manager.events.off('event', write);
      streams.delete(response);
    });
  });
  const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
  if (import.meta.url.endsWith('.js') && existsSync(webRoot + 'index.html')) {
    await app.register(fastifyStatic, { root: webRoot });
  } else
    app.get('/', async (_request, reply) =>
      reply
        .type('text/plain')
        .send('AI Office API is running. Start npm run dev:web and open http://127.0.0.1:5173.'),
    );
  app.addHook('preClose', async () => {
    for (const response of streams) response.end();
    await manager.shutdown();
  });
  return app;
}
