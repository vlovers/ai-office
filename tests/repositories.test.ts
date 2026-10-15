import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertSafePath,
  validateRepository,
  revalidateRepository,
  changedFiles,
} from '../src/server/repositories.js';
import { sandbox } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
describe('repository boundary', () => {
  it('validates Git root, canonicalizes aliases, and reports dirty files without a commit', async () => {
    const env = await sandbox();
    cleanups.push(env.cleanup);
    const alias = join(env.root, 'alias');
    await symlink(env.repository, alias);
    const result = await validateRepository(alias);
    expect(result.path).toBe(await (await import('node:fs/promises')).realpath(env.repository));
    expect(await changedFiles(result.path)).toEqual([{ path: 'README.md', status: '??' }]);
    const registered = env.store.register(result);
    expect(env.store.register(await validateRepository(env.repository)).id).toBe(registered.id);
    await expect(revalidateRepository({ ...registered, gitDir: '/changed' })).rejects.toThrow(
      'identity changed',
    );
  });
  it('rejects relative, excluded, non-Git, and nested paths, including aliases to exclusions', async () => {
    expect(() => assertSafePath('relative/path')).toThrow('absolute');
    expect(() => assertSafePath('/projects/Estima')).toThrow('excluded');
    expect(() => assertSafePath('/projects/pixel-office/subdir')).toThrow('excluded');
    const env = await sandbox();
    cleanups.push(env.cleanup);
    const nested = join(env.repository, 'src');
    await mkdir(nested);
    await expect(validateRepository(nested)).rejects.toThrow('root');
    await expect(validateRepository(env.root)).rejects.toThrow('Git worktree');
    await expect(validateRepository(join(env.root, 'missing'))).rejects.toThrow('does not exist');
    const excluded = join(env.root, 'Estima');
    await mkdir(excluded);
    const alias = join(env.root, 'ordinary-name');
    await symlink(excluded, alias);
    await expect(validateRepository(alias)).rejects.toThrow('excluded');
  });
});
