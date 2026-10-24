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
  "import { recoverRegisteredDeliveryWorkspaces } from './src/server/delivery-startup-coordinator.ts';",
  'const db = new DatabaseSync(process.argv[1]);',
  'try {',
  '  const registration = JSON.parse(process.argv[2]);',
  '  const report = await recoverRegisteredDeliveryWorkspaces({',
  '    journal: new DeliveryJournal(db),',
  '    transferJournal: new DeliveryGitTransferJournal(db),',
  '    registrations: [registration],',
  '  });',
  '  process.stdout.write(JSON.stringify(report));',
  '} catch { process.stdout.write("blocked"); } finally { db.close(); }',
].join('\n');

describe('Delivery startup recovery across independent Node processes', () => {
  it('never steals a live Git lease and recovers exactly once after release', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ai-office-startup-process-')));
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
        return child.stdout;
      };
      await withDeliveryRepositoryLease(repository, repository.gitDir, async () => {
        expect(recoverInChild()).toBe('blocked');
        expect(journal.get('workspace-a')?.state).toBe('reserved');
        expect(transfers.get('workspace-a', 'commit')?.state).toBe('intent');
      });
      const recovered = JSON.parse(recoverInChild()) as Array<{
        workspaceId: string;
        publication: { state: string };
        commit: { state: string };
      }>;
      expect(recovered[0]?.publication.state).toBe('uncertain');
      expect(recovered[0]?.commit.state).toBe('uncertain');
      const repeat = JSON.parse(recoverInChild());
      expect(repeat).toEqual(recovered);
      expect(journal.get('workspace-a')?.state).toBe('uncertain');
      expect(transfers.get('workspace-a', 'commit')?.state).toBe('uncertain');
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
