import { expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { sandbox } from './helpers.js';
import { Store } from '../src/server/store.js';

it('validates, versions, duplicates and archives registry profiles without losing history', async () => {
  const env = await sandbox();
  const app = await createApp(env.manager);
  const headers = { host: '127.0.0.1:4310', 'content-type': 'application/json' };
  const post = (url: string, payload: unknown) =>
    app.inject({ method: 'POST', url, headers, payload: JSON.stringify(payload) });
  try {
    const settings = {
      name: 'Reviewer',
      role: 'Security review',
      instructions: '<script>alert(1)</script>',
    };
    const result = await post('/api/agents', settings);
    expect(result.statusCode).toBe(201);
    const profile = result.json();
    expect(profile.maximumMode).toBe('read-only');
    expect(profile.id).not.toContain('Reviewer');
    const edit = await post(`/api/agents/${profile.id}`, {
      ...settings,
      name: 'Edited',
      revision: 1,
    });
    expect(edit.json().revision).toBe(2);
    expect((await post(`/api/agents/${profile.id}`, { ...settings, revision: 1 })).statusCode).toBe(
      409,
    );
    expect(env.store.agentVersion(profile.id, 1)?.name).toBe('Reviewer');
    expect((await post(`/api/agents/${profile.id}/duplicate`, { revision: 1 })).statusCode).toBe(
      409,
    );
    const duplicate = await post(`/api/agents/${profile.id}/duplicate`, { revision: 2 });
    expect(duplicate.json().name).toBe('Edited');
    expect(duplicate.json().id).not.toBe(profile.id);
    expect(duplicate.json().revision).toBe(1);
    expect(
      (await post(`/api/agents/${profile.id}/archive`, { revision: 2, archived: true })).json()
        .archived,
    ).toBe(true);
    expect(
      (await post(`/api/agents/${profile.id}/archive`, { revision: 3, archived: false })).json()
        .revision,
    ).toBe(4);
    const reopened = new Store(env.store.db.location()!);
    expect(reopened.agent(profile.id)?.name).toBe('Edited');
    expect(reopened.agents().map((p) => p.order)).toEqual([1, 2, 3, 4]);
    reopened.close();
    for (const bad of [
      { ...settings, id: '../../escape' },
      { ...settings, 'sk-syntheticcredential123456': true },
      { ...settings, instructions: 'x'.repeat(12001) },
      { ...settings, name: '\u001bname' },
      { ...settings, model: '--config=unsafe' },
      { ...settings, instructions: 'sk-syntheticcredential123456' },
      { ...settings, maximumMode: 'unrestricted' },
      { ...settings, config: { sandbox: false } },
    ]) {
      const response = await post('/api/agents', bad);
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain('syntheticcredential');
    }
    expect(env.store.agents()).toHaveLength(4);
    expect(
      (await post('/api/agents/missing/archive', { revision: 1, archived: true })).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/agents',
          headers: { ...headers, origin: 'https://hostile.example' },
          payload: settings,
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    await app.close();
    await env.cleanup();
  }
});

it('rejects the configured secret without persisting or reflecting it', async () => {
  const env = await sandbox();
  const { TaskManager } = await import('../src/server/manager.js');
  const secret = 'synthetic-configured-credential';
  const manager = new TaskManager(env.store, env.providers, env.auth, secret);
  const app = await createApp(manager);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: { host: '127.0.0.1:4310', 'content-type': 'application/json' },
      payload: { name: 'Rejected', role: 'Review', instructions: `Do not retain ${secret}` },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(secret);
    expect(JSON.stringify(env.store.agents())).not.toContain(secret);
    expect(env.store.agents()).toHaveLength(2);
    expect(env.store.tasks()).toEqual([]);
  } finally {
    await app.close();
    await env.cleanup();
  }
});
