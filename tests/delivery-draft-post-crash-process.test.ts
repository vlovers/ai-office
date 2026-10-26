import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { DeliveryJournal } from '../src/server/delivery-journal.js';
import { repositoryLeaseDirectories } from '../src/server/repositories.js';

const childScript = [
  "import { DatabaseSync } from 'node:sqlite';",
  "import { appendFileSync } from 'node:fs';",
  "import { createDraftPublication } from './src/server/delivery-draft-pr-orchestration.ts';",
  "import { DeliveryJournal } from './src/server/delivery-journal.ts';",
  'const db = new DatabaseSync(process.argv[1]);',
  'const repository = JSON.parse(process.argv[2]);',
  'const mode = process.argv[3];',
  'const marker = process.argv[4];',
  "const destination = 'https://github.com/vlovers/ai-office';",
  "const branch = 'ai-office/12345678-1234-1234-1234-123456789abc';",
  "const plan = { allowed: true, destination, branch, baseBranch: 'main', revision: 'a'.repeat(64), draft: true };",
  "const receipt = { html_url: destination + '/pull/123', draft: true, state: 'open', head: { ref: branch, repo: { full_name: 'vlovers/ai-office' } }, base: { ref: 'main', repo: { full_name: 'vlovers/ai-office' } } };",
  'const context = {',
  "  workspaceId: 'workspace-crash', repository, workspaceGitDir: repository.gitDir,",
  '  journal: new DeliveryJournal(db), initialPlan: plan,',
  '  refreshPlan: async () => plan, verifySnapshot: async () => {},',
  "  listRemote: async () => mode === 'incomplete' ? { complete: false, reason: 'page 2 timed out' } : { complete: true, candidates: mode === 'crash' ? [] : [receipt] },",
  '  verifyRemoteReceipt: async (_plan, url) => {',
  "    if (mode === 'mismatch' || url !== receipt.html_url) throw new Error('Independent PR detail verification failed');",
  '  },',
  '  createDraft: async () => {',
  "    appendFileSync(marker, 'POST\\n');",
  "    process.kill(process.pid, 'SIGKILL');",
  "    throw new Error('unreachable after simulated crash');",
  '  },',
  '};',
  'try {',
  '  const result = await createDraftPublication(context);',
  '  process.stdout.write(JSON.stringify(result));',
  '} catch (error) {',
  "  process.stdout.write('BLOCKED:' + String(error.message));",
  '} finally { db.close(); }',
].join('\n');

describe('Draft PR crash and independent-process reconciliation', () => {
  it('never replays a POST after process death, stale Git lease, partial inventory or invalid receipt', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ai-office-draft-post-crash-')));
    const path = join(root, 'repo');
    execFileSync('git', ['init', '-q', path]);
    const repository = { path, gitDir: realpathSync(join(path, '.git')) };
    const dbPath = join(root, 'delivery.sqlite');
    const marker = join(root, 'remote-posts.log');
    const leaseDirectories = await repositoryLeaseDirectories(repository, repository.gitDir);
    const leasePaths = leaseDirectories.map((directory) =>
      join(
        '/tmp',
        `ai-office-worktrees-${process.getuid?.() ?? 'local'}`,
        createHash('sha256').update(directory).digest('hex'),
      ),
    );
    let crashedPid: number | undefined;
    const run = (mode: string) =>
      spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          childScript,
          dbPath,
          JSON.stringify(repository),
          mode,
          marker,
        ],
        { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000 },
      );
    const postCount = () =>
      existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').length : 0;
    const db = new DatabaseSync(dbPath);
    try {
      const journal = new DeliveryJournal(db);
      const crashed = run('crash');
      crashedPid = crashed.pid;
      expect(crashed.error).toBeUndefined();
      expect(crashed.signal).toBe('SIGKILL');
      expect(postCount()).toBe(1);
      expect(journal.get('workspace-crash')?.state).toBe('reserved');

      // A killed process leaves an OS-local lock. Recovery must fail closed
      // until an operator verifies the previous process has exited.
      const blocked = run('recover');
      expect(blocked.status).toBe(0);
      expect(blocked.stdout).toContain('BLOCKED:Resource is locked');
      expect(journal.get('workspace-crash')?.state).toBe('reserved');
      expect(postCount()).toBe(1);

      for (const leasePath of leasePaths) {
        const owner = JSON.parse(readFileSync(join(leasePath, 'owner.json'), 'utf8')) as {
          pid: number;
        };
        expect(owner.pid).toBe(crashedPid);
        expect(() => process.kill(owner.pid, 0)).toThrow();
        // Test-only equivalent of explicit, verified stale-lease cleanup.
        rmSync(leasePath, { recursive: true, force: true });
      }

      const incomplete = run('incomplete');
      expect(incomplete.status).toBe(0);
      expect(JSON.parse(incomplete.stdout).status).toBe('uncertain');
      expect(journal.get('workspace-crash')?.state).toBe('uncertain');
      expect(postCount()).toBe(1);

      const invalid = run('mismatch');
      expect(invalid.status).toBe(0);
      expect(JSON.parse(invalid.stdout).status).toBe('uncertain');
      expect(journal.get('workspace-crash')?.pullRequestUrl).toBeNull();
      expect(postCount()).toBe(1);

      const recovered = run('recover');
      expect(recovered.status).toBe(0);
      expect(JSON.parse(recovered.stdout).status).toBe('published');
      expect(journal.get('workspace-crash')).toMatchObject({
        state: 'published',
        pullRequestUrl: 'https://github.com/vlovers/ai-office/pull/123',
      });
      const reused = run('reuse');
      expect(reused.status).toBe(0);
      expect(JSON.parse(reused.stdout).status).toBe('published');
      expect(postCount()).toBe(1);
    } finally {
      db.close();
      for (const leasePath of leasePaths) {
        if (!existsSync(join(leasePath, 'owner.json'))) continue;
        const owner = JSON.parse(readFileSync(join(leasePath, 'owner.json'), 'utf8')) as {
          pid: number;
        };
        if (owner.pid === crashedPid) rmSync(leasePath, { recursive: true, force: true });
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
