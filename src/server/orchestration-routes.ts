import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TaskManager } from './manager.js';
import {
  OrchestrationStore,
  contextSchema,
  messageSchema,
  proposalSchema,
} from './orchestration.js';
import { git, revalidateRepository } from './repositories.js';
import { AppError } from './errors.js';
import type { OrchestrationSnapshot, PlanValidation } from '../shared/orchestration.js';

const id = z.string().uuid();
const version = z.number().int().nonnegative();
const root = '/api/repositories/:repositoryId';
async function head(path: string) {
  try {
    const revision = (await git(path, ['rev-parse', '--verify', 'HEAD'])).trim();
    if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(revision)) return revision;
  } catch {
    /* No inference or fabricated branch for an unverifiable checkout. */
  }
  throw new AppError(
    409,
    'Cannot verify Git HEAD. Use an accessible repository with an initial commit.',
  );
}
export function registerOrchestrationRoutes(app: FastifyInstance, manager: TaskManager) {
  const store = new OrchestrationStore(manager.store);
  const params = (value: unknown) =>
    z.object({ repositoryId: id, id: id.optional() }).strict().parse(value);
  const repository = async (repositoryId: string) => {
    const record = manager.store.repository(repositoryId);
    if (!record) throw new AppError(404, 'Repository not found.');
    await revalidateRepository(record);
    return record;
  };
  app.get(root + '/orchestration', async (request): Promise<OrchestrationSnapshot> => {
    const { repositoryId } = params(request.params);
    const repo = await repository(repositoryId);
    const revision = await head(repo.path);
    const branch = (await git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const dashboard = manager.dashboard();
    const plans = store.plans(repositoryId);
    return {
      repositoryId,
      branch: { name: branch === 'HEAD' ? null : branch, revision, readOnly: true },
      capabilities: {
        modelPlanning: false,
        modelPlanningReason:
          'Model planning is unavailable. Save an operator-authored proposal; no model call is made.',
        release: false,
        pause: false,
        monetaryBudgets: false,
        maxWorkers: dashboard.concurrency,
        executionReady: dashboard.ready && Boolean(manager.workspaces),
        executionMessage: !dashboard.ready
          ? dashboard.readinessMessage
          : !manager.workspaces
            ? 'Isolated writes are not configured.'
            : 'Run creation is inert. Explicit workflow approvals and Start are required.',
      },
      context: store.context(repositoryId),
      plans,
      templates: store.templates(repositoryId),
      runs: plans.map((plan) => store.run(plan)),
    };
  });
  app.post(root + '/plans', async (request, reply) => {
    const { repositoryId } = params(request.params);
    const input = z.object({ proposal: proposalSchema }).strict().parse(request.body);
    await repository(repositoryId);
    return reply.code(201).send(store.createPlan(repositoryId, input.proposal));
  });
  app.put(root + '/plans/:id', async (request) => {
    const p = params(request.params);
    const input = z.object({ version, proposal: proposalSchema }).strict().parse(request.body);
    await repository(p.repositoryId);
    return store.editPlan(p.repositoryId, p.id!, input.version, input.proposal);
  });
  app.post(root + '/plans/:id/messages', async (request) => {
    const p = params(request.params);
    const input = z.object({ version, text: messageSchema }).strict().parse(request.body);
    await repository(p.repositoryId);
    return store.message(p.repositoryId, p.id!, input.version, input.text);
  });
  app.post(root + '/plans/:id/propose', async (request) => {
    const p = params(request.params);
    z.object({ version }).strict().parse(request.body);
    store.plan(p.repositoryId, p.id!);
    throw new AppError(
      503,
      'Model planning is unavailable. No model call or execution was started.',
    );
  });
  app.post(root + '/plans/:id/validate', async (request): Promise<PlanValidation> => {
    const p = params(request.params);
    const input = z.object({ version, contextRevision: version }).strict().parse(request.body);
    const repo = await repository(p.repositoryId);
    const plan = store.plan(p.repositoryId, p.id!);
    if (plan.version !== input.version || plan.workflowId)
      throw new AppError(409, 'Plan changed or already has a run.');
    if (store.context(p.repositoryId).revision !== input.contextRevision)
      throw new AppError(409, 'Context changed.');
    store.validate(plan);
    const dashboard = manager.dashboard();
    if (!dashboard.ready) throw new AppError(503, dashboard.readinessMessage);
    if (!manager.workspaces) throw new AppError(409, 'Isolated writes are not configured.');
    await manager.workspaces.authorize(repo);
    if ((await git(repo.path, ['status', '--porcelain=v1', '--untracked-files=all'])).trim())
      throw new AppError(409, 'Repository has uncommitted changes.');
    return {
      planId: plan.id,
      version: plan.version,
      contextRevision: input.contextRevision,
      baselineRevision: await head(repo.path),
      checkedAt: new Date().toISOString(),
      notice:
        'Prerequisites checked. This does not grant authority or start work. Every submission rechecks all workflow gates.',
    };
  });
  app.post(root + '/plans/:id/run', async (request, reply) => {
    const p = params(request.params);
    const input = z
      .object({ version, contextRevision: version, confirmed: z.literal(true) })
      .strict()
      .parse(request.body);
    const repo = await repository(p.repositoryId);
    const plan = store.plan(p.repositoryId, p.id!);
    // Return an existing run on retry, while still enforcing repository ownership/version.
    if (plan.workflowId) {
      if (![plan.version, plan.version - 1].includes(input.version))
        throw new AppError(409, 'Plan changed.');
      return { plan, run: store.run(plan) };
    }
    if (!manager.dashboard().ready) throw new AppError(503, manager.dashboard().readinessMessage);
    if (!manager.workspaces)
      throw new AppError(409, 'Configure isolated writes before creating an executable workflow.');
    await manager.workspaces.authorize(repo);
    if ((await git(repo.path, ['status', '--porcelain=v1', '--untracked-files=all'])).trim())
      throw new AppError(409, 'Repository has uncommitted changes.');
    const revision = await head(repo.path);
    const existed = Boolean(store.plan(p.repositoryId, p.id!).workflowId);
    const saved = store.materialize(
      p.repositoryId,
      p.id!,
      input.version,
      input.contextRevision,
      revision,
    );
    return reply.code(existed ? 200 : 201).send({ plan: saved, run: store.run(saved) });
  });
  app.post(root + '/workflow-templates', async (request, reply) => {
    const { repositoryId } = params(request.params);
    const input = z.object({ proposal: proposalSchema }).strict().parse(request.body);
    await repository(repositoryId);
    return reply.code(201).send(store.createTemplate(repositoryId, input.proposal));
  });
  app.put(root + '/workflow-templates/:id', async (request) => {
    const p = params(request.params);
    const input = z
      .object({ version, proposal: proposalSchema, archived: z.boolean() })
      .strict()
      .parse(request.body);
    await repository(p.repositoryId);
    return store.editTemplate(p.repositoryId, p.id!, input.version, input.proposal, input.archived);
  });
  for (const action of ['duplicate', 'instantiate'] as const) {
    app.post(root + '/workflow-templates/:id/' + action, async (request, reply) => {
      const p = params(request.params);
      const input = z.object({ version }).strict().parse(request.body);
      await repository(p.repositoryId);
      const template = store.template(p.repositoryId, p.id!);
      if (template.version !== input.version || template.archived)
        throw new AppError(409, 'Template changed or is archived.');
      return reply.code(201).send(
        action === 'duplicate'
          ? store.createTemplate(
              p.repositoryId,
              {
                ...template.proposal,
                title: (template.proposal.title + ' (copy)').slice(0, 160),
              },
              template.id,
            )
          : store.createPlan(p.repositoryId, template.proposal, {
              id: template.id,
              version: template.version,
            }),
      );
    });
  }
  app.get(root + '/context/history', async (request) => {
    const { repositoryId } = params(request.params);
    await repository(repositoryId);
    return store.contextHistory(repositoryId);
  });
  app.put(root + '/context', async (request) => {
    const { repositoryId } = params(request.params);
    const input = z
      .object({ revision: version, content: contextSchema })
      .strict()
      .parse(request.body);
    await repository(repositoryId);
    return store.saveContext(repositoryId, input.revision, input.content);
  });
  app.post(root + '/context/revert', async (request) => {
    const { repositoryId } = params(request.params);
    const input = z
      .object({
        revision: version,
        targetRevision: z.number().int().positive(),
        confirmed: z.literal(true),
      })
      .strict()
      .parse(request.body);
    await repository(repositoryId);
    return store.saveContext(
      repositoryId,
      input.revision,
      store.context(repositoryId).content,
      input.targetRevision,
    );
  });
}
