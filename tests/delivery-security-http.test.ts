import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import {
  deliverySecurityFixture,
  deliveryHTTP,
  cookieName,
  origin,
} from './fixtures/delivery-security.js';
import { DeliverySessions } from '../src/server/delivery-sessions.js';
import { DeliveryTransferApprovalLedger } from '../src/server/delivery-transfer-approval.js';
import { publicationKey } from '../src/server/delivery-publication-idempotency.js';
import { DeliverySecurityService } from '../src/server/delivery-security-service.js';
import { createDeliverySecurityApp } from '../src/server/delivery-security-app.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function setup() {
  const t = await deliverySecurityFixture();
  cleanups.push(t.close);
  return t;
}
const approve = (reviewId: unknown, operation = 'commit') => ({
  reviewId,
  operation,
  confirmed: true,
});
const intent = (reviewId: unknown, approvalId: unknown, stage = 'commit') => ({
  reviewId,
  approvalId,
  stage,
  confirmed: true,
});

describe('production Delivery HTTP boundary with real Git and SQLite', () => {
  it('exchanges a one-use server ticket, sets a secure host cookie and returns only a CSRF secret', async () => {
    const t = await setup();
    expect(t.auth.response.status).toBe(200);
    expect(t.auth.response.headers.get('set-cookie')).toContain(
      'Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=1800',
    );
    expect(t.auth.response.headers.get('cache-control')).toBe('no-store');
    expect(t.auth.body).not.toHaveProperty('token');
    expect(t.auth.body).not.toHaveProperty('operatorId');
    expect(JSON.stringify(t.auth.body)).not.toContain(t.auth.token);
    const session = await t.request('/session');
    expect(session.response.status).toBe(200);
    expect(session.body.csrfToken).toBe(t.auth.body.csrfToken);
    expect(
      (
        await t.request('/session', {
          body: { ticket: t.ticket },
          headers: { 'x-delivery-enrollment': '1' },
        })
      ).response.status,
    ).toBe(401);
    const raw = JSON.stringify(t.db.prepare('SELECT * FROM delivery_operator_sessions').all());
    expect(raw).not.toContain(t.auth.token);
    expect(raw).not.toContain(t.auth.body.csrfToken);
    expect(JSON.stringify(t.db.prepare('SELECT * FROM delivery_enrollments').all())).not.toContain(
      t.ticket,
    );
  });

  it('rejects absent, invalid, forged and duplicate session cookies with 401', async () => {
    const t = await setup();
    for (const cookie of [
      '',
      `${cookieName}=invalid`,
      `${cookieName}=${'x'.repeat(43)}`,
      `${t.auth.cookie}; ${t.auth.cookie}`,
    ]) {
      const result = await t.request('/workspaces/workspace-a/review', { cookie });
      expect(result.response.status).toBe(401);
      expect(result.body).toEqual({ error: 'Operator authentication required.' });
    }
    expect(
      (
        await t.request('/session', {
          cookie: '',
          headers: {
            authorization: `Bearer ${t.auth.token}`,
            'x-operator-id': 'alice',
            'x-session-id': 'trusted',
          },
        })
      ).response.status,
    ).toBe(401);
  });

  it('expires sessions and enrollment tickets and refuses backwards clocks across reopen', async () => {
    const t = await setup();
    const freshTicket = t.sessions.issueEnrollment('alice');
    t.clock.value = Date.now() + 60_001;
    expect(() => t.sessions.exchangeEnrollment(freshTicket)).toThrow('authentication');
    t.clock.value += 30 * 60_000;
    expect((await t.request('/session')).response.status).toBe(401);
    const otherDb = new DatabaseSync(t.dbPath);
    try {
      const reopened = new DeliverySessions(otherDb, () => 1);
      expect(() => reopened.authenticate(t.auth.token)).toThrow('unavailable');
    } finally {
      otherDb.close();
    }
  });

  it('revokes sessions across SQLite connections and never revives them on operator re-enable', async () => {
    const t = await setup();
    const second = new DatabaseSync(t.dbPath);
    try {
      const sessions = new DeliverySessions(second);
      sessions.revoke(t.auth.token);
      expect((await t.request('/session')).response.status).toBe(401);
      sessions.setOperator('alice', false);
      sessions.setOperator('alice', true);
      expect((await t.request('/session')).response.status).toBe(401);
    } finally {
      second.close();
    }
  });

  it('exchanges a ticket at most once under concurrent real HTTP requests', async () => {
    const t = await setup();
    const ticket = t.sessions.issueEnrollment('alice');
    const responses = await Promise.all(
      [1, 2].map(() =>
        t.request('/session', { body: { ticket }, headers: { 'x-delivery-enrollment': '1' } }),
      ),
    );
    expect(responses.map((value) => value.response.status).sort()).toEqual([200, 401]);
  });

  it('clears the cookie on CSRF-protected logout and rejects later requests', async () => {
    const t = await setup();
    const result = await t.request('/logout', { body: {} });
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await t.request('/session')).response.status).toBe(401);
  });

  it('rejects Origin, Host, forwarded-header, Fetch Metadata and CSRF attacks with 403', async () => {
    const t = await setup();
    const review = await t.request('/workspaces/workspace-a/review');
    const attacks: Record<string, string>[] = [
      { origin: '' },
      { origin: 'null' },
      { origin: 'https://evil.example' },
      { origin: `${origin}.evil.example` },
      { origin: `${origin}/` },
      { origin: `http://delivery.example.test` },
      {
        host: 'evil.example',
        'x-forwarded-host': 'delivery.example.test',
        'x-forwarded-proto': 'https',
      },
      { origin: 'https://evil.example', 'x-forwarded-origin': origin },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
      { 'x-csrf-token': '' },
      { 'x-csrf-token': 'x'.repeat(43) },
    ];
    for (const headers of attacks)
      expect(
        (
          await t.request('/workspaces/workspace-a/approvals', {
            body: approve(review.body.reviewId),
            headers,
          })
        ).response.status,
      ).toBe(403);
    const bob = await t.login('bob');
    expect(
      (
        await t.request('/workspaces/workspace-a/approvals', {
          body: approve(review.body.reviewId),
          cookie: bob.cookie,
        })
      ).response.status,
    ).toBe(403);
    const missingOrigin = await deliveryHTTP(`${t.url}/api/delivery/logout`, {
      method: 'POST',
      headers: {
        host: 'delivery.example.test',
        cookie: t.auth.cookie,
        'Content-Type': 'application/json',
        'x-csrf-token': t.auth.body.csrfToken,
      },
      body: '{}',
    });
    expect(missingOrigin.status).toBe(403);
    expect(missingOrigin.headers.get('access-control-allow-origin')).toBeNull();
    expect(
      (await t.request('/session', { body: { ticket: t.sessions.issueEnrollment('bob') } }))
        .response.status,
    ).toBe(403);
  });

  it('enforces live per-workspace and per-operation grants without trusting JSON identities', async () => {
    const t = await setup();
    expect((await t.request('/workspaces/workspace-b/review')).response.status).toBe(403);
    const review = await t.request('/workspaces/workspace-a/review');
    for (const forged of [
      { operatorId: 'bob' },
      { sessionId: 'admin' },
      { workspaceId: 'workspace-b' },
      { token: 'credential-marker' },
      { approval: true },
      { permissions: ['admin'] },
      { destination: 'https://github.com/evil/repo' },
      { headSha: 'b'.repeat(40) },
    ]) {
      const result = await t.request('/workspaces/workspace-a/approvals', {
        body: { ...approve(review.body.reviewId), ...forged },
      });
      expect(result.response.status).toBe(400);
      expect(JSON.stringify(result.body)).not.toContain('credential-marker');
    }
    t.sessions.setGrant('alice', 'workspace-a', 'approve:commit', false);
    expect(
      (
        await t.request('/workspaces/workspace-a/approvals', {
          body: approve(review.body.reviewId),
        })
      ).response.status,
    ).toBe(403);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM delivery_transfer_approvals').get()?.n).toBe(0);
  });

  it('binds approvals to the reviewed snapshot, exact operator session and stage; reserves once', async () => {
    const t = await setup();
    const review = await t.request('/workspaces/workspace-a/review');
    expect(review.response.status).toBe(200);
    expect(review.body.headSha).toBe(t.workspace.headSha);
    expect(JSON.stringify(review.body)).not.toContain(t.root);
    expect(
      (await t.request('/workspaces/workspace-a/approvals', { body: approve('b'.repeat(64)) }))
        .response.status,
    ).toBe(409);
    const approved = await t.request('/workspaces/workspace-a/approvals', {
      body: approve(review.body.reviewId),
    });
    expect(approved.response.status).toBe(201);
    const bob = await t.login('bob');
    expect(
      (
        await t.request('/workspaces/workspace-a/transfer-intents', {
          cookie: bob.cookie,
          headers: { 'x-csrf-token': bob.body.csrfToken },
          body: intent(review.body.reviewId, approved.body.approvalId),
        })
      ).response.status,
    ).toBe(409);
    expect(
      (
        await t.request('/workspaces/workspace-a/transfer-intents', {
          body: intent(review.body.reviewId, approved.body.approvalId, 'push'),
        })
      ).response.status,
    ).toBe(409);
    const reserved = await t.request('/workspaces/workspace-a/transfer-intents', {
      body: intent(review.body.reviewId, approved.body.approvalId),
    });
    expect(reserved.response.status).toBe(201);
    expect(reserved.body).toEqual({ stage: 'commit', state: 'intent', remoteWritesEnabled: false });
    expect(
      (
        await t.request('/workspaces/workspace-a/transfer-intents', {
          body: intent(review.body.reviewId, approved.body.approvalId),
        })
      ).response.status,
    ).toBe(409);
    expect(t.git('rev-parse', 'HEAD')).toBe(t.workspace.headSha);
    expect(t.git('status', '--porcelain')).toBe('');
  });

  it('rejects approvals from another session of the same operator and observes approval revocation', async () => {
    const t = await setup();
    const review = await t.request('/workspaces/workspace-a/review');
    const approved = await t.request('/workspaces/workspace-a/approvals', {
      body: approve(review.body.reviewId),
    });
    const other = t.sessions.exchangeEnrollment(t.sessions.issueEnrollment('alice'));
    expect(
      (
        await t.request('/workspaces/workspace-a/transfer-intents', {
          cookie: `${cookieName}=${other.token}`,
          headers: { 'x-csrf-token': other.csrfToken },
          body: intent(review.body.reviewId, approved.body.approvalId),
        })
      ).response.status,
    ).toBe(409);
    const revoked = await t.request(
      `/workspaces/workspace-a/approvals/${approved.body.approvalId}/revoke`,
      { body: { operation: 'commit', confirmed: true } },
    );
    expect(revoked.response.status).toBe(200);
    expect(
      (
        await t.request('/workspaces/workspace-a/transfer-intents', {
          body: intent(review.body.reviewId, approved.body.approvalId),
        })
      ).response.status,
    ).toBe(409);
  });

  it('prevents duplicate intents across concurrent HTTP servers sharing real SQLite', async () => {
    const t = await setup();
    const secondDb = new DatabaseSync(t.dbPath);
    secondDb.exec('PRAGMA busy_timeout=2000;');
    const secondService = new DeliverySecurityService(new DeliverySessions(secondDb), [
      t.workspace,
    ]);
    const secondApp = createDeliverySecurityApp(secondService, origin);
    const secondUrl = await secondApp.listen({ host: '127.0.0.1', port: 0 });
    cleanups.push(async () => {
      await secondApp.close();
      secondDb.close();
    });
    const review = await t.request('/workspaces/workspace-a/review');
    const approved = await t.request('/workspaces/workspace-a/approvals', {
      body: approve(review.body.reviewId),
    });
    const body = intent(review.body.reviewId, approved.body.approvalId);
    const results = await Promise.all([
      t
        .request('/workspaces/workspace-a/transfer-intents', { body })
        .then((r) => r.response.status),
      deliveryHTTP(`${secondUrl}/api/delivery/workspaces/workspace-a/transfer-intents`, {
        method: 'POST',
        headers: {
          host: 'delivery.example.test',
          origin,
          cookie: t.auth.cookie,
          'x-csrf-token': t.auth.body.csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }).then((r) => r.status),
    ]);
    expect(results.sort()).toEqual([201, 409]);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM delivery_git_transfers').get()?.n).toBe(1);
  });

  it('rechecks session/grant revocation during asynchronous Git review before issuing approval', async () => {
    const t = await setup();
    const review = await t.service.review(t.auth.token, 'workspace-a');
    const pending = t.service.approve(t.auth.token, 'workspace-a', 'commit', review.reviewId);
    t.sessions.setGrant('alice', 'workspace-a', 'approve:commit', false);
    await expect(pending).rejects.toMatchObject({ statusCode: 403 });
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM delivery_transfer_approvals').get()?.n).toBe(0);
    t.sessions.setGrant('alice', 'workspace-a', 'approve:commit', true);
    const revoked = t.service.approve(t.auth.token, 'workspace-a', 'commit', review.reviewId);
    t.sessions.revoke(t.auth.token);
    await expect(revoked).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rechecks revocation during asynchronous reservation and leaves approval pending', async () => {
    const t = await setup();
    const review = await t.service.review(t.auth.token, 'workspace-a');
    const approved = await t.service.approve(
      t.auth.token,
      'workspace-a',
      'commit',
      review.reviewId,
    );
    const pending = t.service.reserve(
      t.auth.token,
      'workspace-a',
      'commit',
      review.reviewId,
      approved.approvalId,
    );
    t.sessions.revoke(t.auth.token);
    await expect(pending).rejects.toMatchObject({ statusCode: 401 });
    expect(t.service.journal.get('workspace-a', 'commit')).toBeNull();
    expect(
      t.db
        .prepare('SELECT consumed_at FROM delivery_transfer_approvals WHERE approval_id=?')
        .get(approved.approvalId)?.consumed_at,
    ).toBeNull();
  });

  it('rejects stale Git, changed origin and expired approvals without credential/path leakage', async () => {
    const t = await setup();
    const review = await t.request('/workspaces/workspace-a/review');
    const approved = await t.request('/workspaces/workspace-a/approvals', {
      body: approve(review.body.reviewId),
    });
    writeFileSync(join(t.workspace.worktree.path, 'README'), 'unreviewed');
    const dirty = await t.request('/workspaces/workspace-a/transfer-intents', {
      body: intent(review.body.reviewId, approved.body.approvalId),
    });
    expect(dirty.response.status).toBe(409);
    expect(JSON.stringify(dirty.body)).not.toContain(t.root);
    writeFileSync(join(t.workspace.worktree.path, 'README'), 'reviewed\n');
    t.git('remote', 'set-url', 'origin', 'https://credential-marker@github.com/evil/repo');
    const wrong = await t.request('/workspaces/workspace-a/review');
    expect(wrong.response.status).toBe(409);
    expect(JSON.stringify(wrong.body)).not.toContain('credential-marker');
    t.git('remote', 'set-url', 'origin', t.workspace.plan.destination);
    t.clock.value = Date.now() + 5 * 60_000 + 100;
    expect(
      (
        await t.request('/workspaces/workspace-a/transfer-intents', {
          body: intent(review.body.reviewId, approved.body.approvalId),
        })
      ).response.status,
    ).toBe(409);
    expect(t.service.journal.get('workspace-a', 'commit')).toBeNull();
  });

  it('requires commit/push receipts for push and draft approval and never provides a remote executor', async () => {
    const t = await setup();
    const review = await t.request('/workspaces/workspace-a/review');
    for (const operation of ['push', 'draft-pr'])
      expect(
        (
          await t.request('/workspaces/workspace-a/approvals', {
            body: approve(review.body.reviewId, operation),
          })
        ).response.status,
      ).toBe(409);
    const identity = {
      workspaceId: 'workspace-a',
      operationKey: publicationKey(t.workspace.plan),
      destination: t.workspace.plan.destination,
      branch: t.workspace.plan.branch,
      headSha: t.workspace.headSha,
      baseSha: t.workspace.baseSha,
    };
    // Trusted fixture receipts stand in for independently completed manual operations.
    for (const stage of ['commit', 'push'] as const) {
      t.service.journal.begin(stage, identity);
      t.service.journal.confirmVerified(stage, identity, identity.headSha);
    }
    const draft = await t.request('/workspaces/workspace-a/approvals', {
      body: approve(review.body.reviewId, 'draft-pr'),
    });
    expect(draft.response.status).toBe(201);
    expect(
      t.db
        .prepare('SELECT operator_id FROM delivery_publication_approvals WHERE approval_id=?')
        .get(String(draft.body.approvalId))?.operator_id,
    ).toBe('alice');
    expect(
      (
        await t.request(`/workspaces/workspace-a/approvals/${draft.body.approvalId}/revoke`, {
          body: { operation: 'draft-pr', confirmed: true },
        })
      ).response.status,
    ).toBe(200);
    for (const route of ['push', 'commit', 'publish', 'merge', 'force-push'])
      expect(
        (await t.request(`/workspaces/workspace-a/${route}`, { body: {} })).response.status,
      ).toBe(404);
    expect(
      (await t.request('/workspaces/workspace-a/remote-status', { body: {} })).response.status,
    ).toBe(503);
  });

  it('rejects oversized, malformed, non-JSON and unconfirmed requests without reflecting inputs', async () => {
    const t = await setup();
    expect(
      (await t.request('/logout', { body: { secret: 's'.repeat(9000) } })).response.status,
    ).toBe(413);
    expect((await t.request('/logout', { body: '{credential-marker' })).response.status).toBe(400);
    expect(
      (await t.request('/logout', { body: '{}', headers: { 'Content-Type': 'text/plain' } }))
        .response.status,
    ).toBe(415);
    expect(
      (
        await t.request('/workspaces/workspace-a/approvals', {
          body: { operation: 'commit', reviewId: 'a'.repeat(64), confirmed: false },
        })
      ).response.status,
    ).toBe(400);
    expect(() => createDeliverySecurityApp(t.service, 'http://delivery.example.test')).toThrow();
    expect(() => createDeliverySecurityApp(t.service, `${origin}/`)).toThrow();
  });

  it('rolls back reservation and preserves pending approval when live authorization fails inside the transaction', async () => {
    const t = await setup();
    const review = await t.request('/workspaces/workspace-a/review');
    const approved = await t.request('/workspaces/workspace-a/approvals', {
      body: approve(review.body.reviewId),
    });
    t.sessions.setGrant('alice', 'workspace-a', 'reserve:commit', false);
    expect(
      (
        await t.request('/workspaces/workspace-a/transfer-intents', {
          body: intent(review.body.reviewId, approved.body.approvalId),
        })
      ).response.status,
    ).toBe(403);
    const operator = t.sessions.authenticate(t.auth.token);
    new DeliveryTransferApprovalLedger(t.db).assertPending(String(approved.body.approvalId), {
      stage: 'commit',
      operator,
      identity: {
        workspaceId: 'workspace-a',
        operationKey: publicationKey(t.workspace.plan),
        destination: t.workspace.plan.destination,
        branch: t.workspace.plan.branch,
        headSha: t.workspace.headSha,
        baseSha: t.workspace.baseSha,
      },
    });
    expect(t.service.journal.get('workspace-a', 'commit')).toBeNull();
  });
});
