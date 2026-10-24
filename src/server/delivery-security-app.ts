import Fastify, { type FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  approvalOperationSchema,
  type DeliverySecurityService,
} from './delivery-security-service.js';
import { deliveryIdentifierSchema, DeliverySecurityError } from './delivery-sessions.js';

const COOKIE = '__Host-ai-office-delivery';
const reviewId = z.string().regex(/^[a-f0-9]{64}$/);
const approvalId = z.string().uuid();
const cookie = (token: string, maxAge: number) =>
  `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;

function sessionToken(request: FastifyRequest): string {
  const matches = (request.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.split('=')[0] === COOKIE);
  if (matches.length !== 1) throw new DeliverySecurityError(401);
  const token = matches[0]!.slice(COOKIE.length + 1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new DeliverySecurityError(401);
  return token;
}

/**
 * Dedicated HTTPS-origin Delivery API. Do NOT mount the local dashboard on
 * this ingress. TLS terminates at a trusted proxy preserving the configured
 * Host; forwarded identity/origin/protocol headers never grant authority.
 */
export function createDeliverySecurityApp(service: DeliverySecurityService, publicOrigin: string) {
  const origin = new URL(publicOrigin);
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== publicOrigin ||
    origin.username ||
    origin.password
  )
    throw new DeliverySecurityError(503);
  const app = Fastify({
    logger: false,
    trustProxy: false,
    bodyLimit: 8192,
    requestTimeout: 10_000,
    connectionTimeout: 15_000,
    forceCloseConnections: true,
    routerOptions: { maxParamLength: 200 },
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DeliverySecurityError)
      return reply.code(error.statusCode).send({ error: error.message });
    if (error instanceof z.ZodError)
      return reply.code(400).send({ error: 'Invalid delivery request.' });
    const code = (error as { statusCode?: number }).statusCode;
    const status = code === 413 ? 413 : code === 415 ? 415 : code === 400 ? 400 : 503;
    return reply.code(status).send({
      error: status === 503 ? 'Delivery service unavailable.' : 'Invalid delivery request.',
    });
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: 'Delivery route unavailable.' }),
  );
  app.addHook('onRequest', async (request, reply) => {
    reply.headers({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'Strict-Transport-Security': 'max-age=31536000',
    });
    if (request.headers.host !== origin.host) throw new DeliverySecurityError(403);
    const source = request.headers.origin;
    if (source !== undefined && source !== publicOrigin) throw new DeliverySecurityError(403);
    const site = request.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none')
      throw new DeliverySecurityError(403);
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (mutation) {
      if (source !== publicOrigin) throw new DeliverySecurityError(403);
      if (
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')
      )
        return reply.code(415).send({ error: 'Invalid delivery request.' });
    }
    const enrollment =
      request.method === 'POST' && request.routeOptions.url === '/api/delivery/session';
    if (enrollment) {
      // Custom non-simple header + exact Origin also protect login CSRF.
      if (request.headers['x-delivery-enrollment'] !== '1') throw new DeliverySecurityError(403);
    } else {
      const token = sessionToken(request);
      service.sessions.authenticate(token);
      if (mutation) service.sessions.assertCSRF(token, request.headers['x-csrf-token']);
    }
  });
  app.post('/api/delivery/session', async (request, reply) => {
    const input = z
      .object({ ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
      .strict()
      .parse(request.body);
    const session = service.sessions.exchangeEnrollment(input.ticket);
    reply.header('Set-Cookie', cookie(session.token, Math.floor(session.lifetimeMs / 1000)));
    return {
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt,
      remoteWritesEnabled: false,
    };
  });
  app.get('/api/delivery/session', async (request) => {
    z.object({}).strict().parse(request.query);
    const token = sessionToken(request);
    return {
      csrfToken: service.sessions.csrfToken(token),
      expiresAt: service.sessions.authenticate(token).expiresAt,
      remoteWritesEnabled: false,
    };
  });
  app.post('/api/delivery/logout', async (request, reply) => {
    z.object({}).strict().parse(request.body);
    service.sessions.revoke(sessionToken(request));
    reply.header('Set-Cookie', cookie('', 0));
    return { revoked: true };
  });
  const workspaceId = (request: FastifyRequest) =>
    deliveryIdentifierSchema.parse((request.params as { workspaceId: string }).workspaceId);
  app.get('/api/delivery/workspaces/:workspaceId/review', async (request) => {
    z.object({}).strict().parse(request.query);
    return service.review(sessionToken(request), workspaceId(request));
  });
  app.post('/api/delivery/workspaces/:workspaceId/approvals', async (request, reply) => {
    const input = z
      .object({ operation: approvalOperationSchema, reviewId, confirmed: z.literal(true) })
      .strict()
      .parse(request.body);
    return reply
      .code(201)
      .send(
        await service.approve(
          sessionToken(request),
          workspaceId(request),
          input.operation,
          input.reviewId,
        ),
      );
  });
  app.post(
    '/api/delivery/workspaces/:workspaceId/approvals/:approvalId/revoke',
    async (request) => {
      const input = z
        .object({ operation: approvalOperationSchema, confirmed: z.literal(true) })
        .strict()
        .parse(request.body);
      return service.revokeApproval(
        sessionToken(request),
        workspaceId(request),
        input.operation,
        approvalId.parse((request.params as { approvalId: string }).approvalId),
      );
    },
  );
  app.post('/api/delivery/workspaces/:workspaceId/transfer-intents', async (request, reply) => {
    const input = z
      .object({
        stage: z.enum(['commit', 'push']),
        reviewId,
        approvalId,
        confirmed: z.literal(true),
      })
      .strict()
      .parse(request.body);
    return reply
      .code(201)
      .send(
        await service.reserve(
          sessionToken(request),
          workspaceId(request),
          input.stage,
          input.reviewId,
          input.approvalId,
        ),
      );
  });
  app.post('/api/delivery/workspaces/:workspaceId/remote-status', async (request) => {
    z.object({}).strict().parse(request.body);
    return service.remoteStatus(sessionToken(request), workspaceId(request));
  });
  return app;
}
