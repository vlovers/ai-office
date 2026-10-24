import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { DeliveryGitTransferJournal } from '../src/server/delivery-git-transfer-journal.js';
import { DeliveryJournal } from '../src/server/delivery-journal.js';
import { withDeliveryRepositoryLease } from '../src/server/delivery-publication-lease.js';

const script = [
  "import { DatabaseSync } from 'node:sqlite';",
  "import { DeliveryJournal } from './src/server/delivery-journal.ts';",
  "import { DeliveryGitTransferJournal } from './src/server/delivery-git-transfer-journal.ts';",
  "import { recoverRegisteredDeliveryOperations } from './src/server/delivery-startup-recovery.ts';",
  'const db = new DatabaseSync(process.argv[1]);',
  'try {',
  '  const registration = JSON.parse(process.argv[2]);',
  '  const report = await recoverRegisteredDeliveryOperations(',
  '    new DeliveryJournal(db),',
  '    new DeliveryGitTransferJournal(db),',
  '    async () => registration,',
  '  );',
  '  process.stdout.write(JSON.stringify(report));',
  '} finally { db.close(); }',
].join('\n');

describe('Delivery startup recovery across independent Node processes', () => {
  it('never steals a live Git lease and recovers exactly once after release', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-office-startup-process-'));
    const path = join(root, 'repo');
    execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main', path]);
    const git = (...args: string[]) =>
      execFileSync('/usr/bin/git', ['-C', path, ...args], { encoding: 'utf8' }).trim();
    git('config', 'user.name', 'AI Office Test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(path, 'README'), 'initial\n');
    git('add', 'README');
    git('commit', '-qm', 'initial');
    const sha = git('rev-parse', 'HEAD');
    const repository = { path, gitDir: realpathSync(join(path, '.git')) };
    const dbPath = join(root, 'delivery.sqlite');
    const registration = {
      workspaceId: 'workspace-a',
      operationKey: 'operation-a',
      repository,
      worktree: repository,
      transferIdentity: {
        workspaceId: 'workspace-a',
        operationKey: 'operation-a',
        destination: 'https://github.com/vlovers/ai-office',
        branch: 'ai-office/12345678-1234-1234-1234-123456789abc',
        headSha: sha,
        baseSha: sha,
      },
    };
    const db = new DatabaseSync(dbPath);
    try {
      const journal = new DeliveryJournal(db);
      const transfers = new DeliveryGitTransferJournal(db);
      journal.reserve(registration.workspaceId, registration.operationKey);
      transfers.begin('commit', registration.transferIdentity);
      const recoverInChild = () => {
        const child = spawnSync(
          process.execPath,
          [
            '--import',
            'tsx',
            '--input-type=module',
            '-e',
            script,
            dbPath,
            JSON.stringify(registration),
          ],
          { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000 },
        );
        expect(child.error).toBeUndefined();
        expect(child.status).toBe(0);
        return JSON.parse(child.stdout) as {
          recovered: Array<{ workspaceId: string; commit: string; publication: string }>;
          blocked: Array<{ workspaceId: string; reason: string }>;
        };
      };
      await withDeliveryRepositoryLease(repository, repository.gitDir, async () => {
        const blocked = recoverInChild();
        expect(blocked.recovered).toEqual([]);
        expect(blocked.blocked).toEqual([
          { workspaceId: 'workspace-a', reason: 'lease-or-recovery-failed' },
        ]);
        expect(journal.get('workspace-a')?.state).toBe('reserved');
        expect(transfers.get('workspace-a', 'commit')?.state).toBe('intent');
      });
      const recovered = recoverInChild();
      expect(recovered.blocked).toEqual([]);
      expect(recovered.recovered[0]?.publication).toBe('uncertain');
      expect(recovered.recovered[0]?.commit).toBe('uncertain');
      const repeat = recoverInChild();
      expect(repeat).toEqual(recovered);
      expect(journal.get('workspace-a')?.state).toBe('uncertain');
      expect(transfers.get('workspace-a', 'commit')?.state).toBe('uncertain');
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
