import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { TrustedDeliveryOperator } from './delivery-publication-approval.js';

export const deliveryOperationSchema = z.enum([
  'review',
  'approve:commit',
  'approve:push',
  'approve:draft-pr',
  'reserve:commit',
  'reserve:push',
  'remote:read',
]);
export type DeliveryOperation = z.infer<typeof deliveryOperationSchema>;
export const deliveryIdentifierSchema = z.string().regex(/^[A-Za-z0-9_.:@-]{1,200}$/);
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const MAX_SESSION_MS = 8 * 60 * 60_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const csrfFor = (token: string) =>
  createHmac('sha256', token).update('ai-office/delivery/csrf/v1').digest('base64url');

/** Deliberately fixed public messages; no nested error/cause or input is reflected. */
export class DeliverySecurityError extends Error {
  constructor(public readonly statusCode: 400 | 401 | 403 | 409 | 503) {
    super(
      {
        400: 'Invalid delivery request.',
        401: 'Operator authentication required.',
        403: 'Delivery access denied.',
        409: 'Delivery state changed or approval unavailable.',
        503: 'Delivery service unavailable.',
      }[statusCode],
    );
  }
}

/**
 * Trusted OS administrator/upstream identity adapter only. No HTTP method can
 * provision grants, select an operator, or issue enrollment tickets.
 * Store only hashes of 256-bit bearer secrets; read grants live on every use.
 */
export class DeliverySessions {
  constructor(
    readonly db: DatabaseSync,
    readonly now: () => number = Date.now,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_security_version (
        id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO delivery_security_version VALUES (1, 1);
    `);
    if (db.prepare('SELECT version FROM delivery_security_version WHERE id=1').get()?.version !== 1)
      throw new DeliverySecurityError(503);
    db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_security_clock (
        id INTEGER PRIMARY KEY CHECK(id=1), last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delivery_operators (
        operator_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
      );
      CREATE TABLE IF NOT EXISTS delivery_workspace_grants (
        operator_id TEXT NOT NULL, workspace_id TEXT NOT NULL, operation TEXT NOT NULL,
        PRIMARY KEY(operator_id, workspace_id, operation)
      );
      CREATE TABLE IF NOT EXISTS delivery_enrollments (
        token_hash TEXT PRIMARY KEY, operator_id TEXT NOT NULL,
        issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS delivery_operator_sessions (
        token_hash TEXT PRIMARY KEY, session_id TEXT UNIQUE NOT NULL, operator_id TEXT NOT NULL,
        csrf_hash TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
    `);
  }

  private timestamp(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new DeliverySecurityError(503);
    const result = this.db
      .prepare(
        `INSERT INTO delivery_security_clock VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at
        WHERE delivery_security_clock.last_seen_at<=excluded.last_seen_at`,
      )
      .run(now);
    if (result.changes !== 1) throw new DeliverySecurityError(503);
    return now;
  }

  setOperator(operatorId: string, enabled: boolean): void {
    deliveryIdentifierSchema.parse(operatorId);
    z.boolean().parse(enabled);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO delivery_operators VALUES (?, ?)
        ON CONFLICT(operator_id) DO UPDATE SET enabled=excluded.enabled`,
        )
        .run(operatorId, Number(enabled));
      if (!enabled) {
        const now = this.timestamp();
        this.db
          .prepare(
            'UPDATE delivery_operator_sessions SET revoked_at=? WHERE operator_id=? AND revoked_at IS NULL',
          )
          .run(now, operatorId);
        this.db
          .prepare(
            'UPDATE delivery_enrollments SET consumed_at=? WHERE operator_id=? AND consumed_at IS NULL',
          )
          .run(now, operatorId);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  setGrant(
    operatorId: string,
    workspaceId: string,
    operation: DeliveryOperation,
    allowed: boolean,
  ): void {
    deliveryIdentifierSchema.parse(operatorId);
    deliveryIdentifierSchema.parse(workspaceId);
    deliveryOperationSchema.parse(operation);
    z.boolean().parse(allowed);
    if (allowed)
      this.db
        .prepare('INSERT OR IGNORE INTO delivery_workspace_grants VALUES (?, ?, ?)')
        .run(operatorId, workspaceId, operation);
    else
      this.db
        .prepare(
          'DELETE FROM delivery_workspace_grants WHERE operator_id=? AND workspace_id=? AND operation=?',
        )
        .run(operatorId, workspaceId, operation);
  }

  /** Display once through a trusted admin channel. Never log or put in a URL. */
  issueEnrollment(operatorId: string): string {
    deliveryIdentifierSchema.parse(operatorId);
    const now = this.timestamp();
    const ticket = secret();
    const result = this.db
      .prepare(
        `INSERT INTO delivery_enrollments
      SELECT ?, operator_id, ?, ?, NULL FROM delivery_operators WHERE operator_id=? AND enabled=1`,
      )
      .run(hash(ticket), now, now + 60_000, operatorId);
    if (result.changes !== 1) throw new DeliverySecurityError(403);
    return ticket;
  }

  /** One-use ticket exchange; new random session defeats session fixation. */
  exchangeEnrollment(ticket: string, lifetimeMs = 30 * 60_000) {
    if (typeof ticket !== 'string' || !SECRET.test(ticket)) throw new DeliverySecurityError(401);
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0 || lifetimeMs > MAX_SESSION_MS)
      throw new DeliverySecurityError(503);
    const now = this.timestamp();
    if (!Number.isSafeInteger(now + lifetimeMs)) throw new DeliverySecurityError(503);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const enrollment = this.db
        .prepare(
          `UPDATE delivery_enrollments SET consumed_at=?
        WHERE token_hash=? AND issued_at<=? AND expires_at>? AND consumed_at IS NULL
        AND EXISTS (SELECT 1 FROM delivery_operators o WHERE o.operator_id=delivery_enrollments.operator_id AND o.enabled=1)
        AND (SELECT last_seen_at FROM delivery_security_clock WHERE id=1)=?
        RETURNING operator_id`,
        )
        .get(now, hash(ticket), now, now, now);
      if (!enrollment) throw new DeliverySecurityError(401);
      const token = secret();
      const csrfToken = csrfFor(token);
      const sessionId = randomUUID();
      this.db
        .prepare('INSERT INTO delivery_operator_sessions VALUES (?, ?, ?, ?, ?, ?, NULL)')
        .run(
          hash(token),
          sessionId,
          String(enrollment.operator_id),
          hash(csrfToken),
          now,
          now + lifetimeMs,
        );
      this.db.exec('COMMIT');
      return { token, csrfToken, expiresAt: now + lifetimeMs, lifetimeMs };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  authenticate(token: string): TrustedDeliveryOperator & { expiresAt: number } {
    if (typeof token !== 'string' || !SECRET.test(token)) throw new DeliverySecurityError(401);
    const now = this.timestamp();
    const row = this.db
      .prepare(
        `SELECT s.session_id, s.operator_id, s.expires_at
      FROM delivery_operator_sessions s JOIN delivery_operators o USING(operator_id)
      WHERE s.token_hash=? AND s.revoked_at IS NULL AND o.enabled=1
      AND s.issued_at<=? AND s.expires_at>?
      AND (SELECT last_seen_at FROM delivery_security_clock WHERE id=1)=?`,
      )
      .get(hash(token), now, now, now);
    if (!row) throw new DeliverySecurityError(401);
    return {
      operatorId: String(row.operator_id),
      sessionId: String(row.session_id),
      expiresAt: Number(row.expires_at),
    };
  }

  authorize(
    token: string,
    workspaceId: string,
    operation: DeliveryOperation,
  ): TrustedDeliveryOperator {
    const operator = this.authenticate(token);
    deliveryIdentifierSchema.parse(workspaceId);
    deliveryOperationSchema.parse(operation);
    if (
      !this.db
        .prepare(
          'SELECT 1 FROM delivery_workspace_grants WHERE operator_id=? AND workspace_id=? AND operation=?',
        )
        .get(operator.operatorId, workspaceId, operation)
    )
      throw new DeliverySecurityError(403);
    return { operatorId: operator.operatorId, sessionId: operator.sessionId };
  }

  csrfToken(token: string): string {
    this.authenticate(token);
    return csrfFor(token);
  }

  assertCSRF(token: string, supplied: unknown): void {
    this.authenticate(token);
    if (typeof supplied !== 'string' || !SECRET.test(supplied))
      throw new DeliverySecurityError(403);
    const row = this.db
      .prepare('SELECT csrf_hash FROM delivery_operator_sessions WHERE token_hash=?')
      .get(hash(token));
    if (!row || !timingSafeEqual(Buffer.from(hash(supplied)), Buffer.from(String(row.csrf_hash))))
      throw new DeliverySecurityError(403);
  }

  revoke(token: string): void {
    this.authenticate(token);
    this.db
      .prepare(
        'UPDATE delivery_operator_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL',
      )
      .run(this.timestamp(), hash(token));
  }

  /** Synchronous only: no network/await while the SQLite write lock is held. */
  withAuthorization<T>(
    token: string,
    workspaceId: string,
    operation: DeliveryOperation,
    action: (operator: TrustedDeliveryOperator) => T,
  ): T {
    this.timestamp();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action(this.authorize(token, workspaceId, operation));
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        void Promise.resolve(result).catch(() => undefined);
        throw new DeliverySecurityError(503);
      }
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
