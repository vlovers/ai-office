import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TaskManager } from './manager.js';
import { AppError } from './errors.js';
import { validateRepository } from './repositories.js';
import type { AgentEvent } from '../shared/types.js';

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
        details: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
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
  app.post('/api/tasks', async (request, reply) => {
    const input = z
      .object({
        repositoryId: id,
        agentId: z.enum(['codex-1', 'codex-2']),
        executionMode: z.enum(['read-only', 'write']).default('read-only'),
        title: z.string().trim().min(1).max(160),
        prompt: z.string().trim().min(1).max(16000),
      })
      .strict()
      .parse(request.body);
    if (!manager.store.repository(input.repositoryId))
      throw new AppError(404, 'Repository not found.');
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
