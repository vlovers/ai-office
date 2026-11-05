import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateManifest, verifyIntegrationStack } from '../scripts/verify-integration-stack.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-office-stack-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'Fixture');
    git(dir, 'config', 'user.email', 'fixture@example.invalid');
    writeFileSync(join(dir, 'a.txt'), 'base\n');
    git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'initial');
    const baseSha = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'switch', '-qc', 'feat/one');
    writeFileSync(join(dir, 'a.txt'), 'one\n'); git(dir, 'commit', '-qam', 'one');
    const firstSha = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'switch', '-qc', 'feat/two');
    writeFileSync(join(dir, 'a.txt'), 'two\n'); git(dir, 'commit', '-qam', 'two');
    const secondSha = git(dir, 'rev-parse', 'HEAD');
    fn({ dir, baseSha, firstSha, secondSha,
      manifest: { version: 1, baseSha, steps: [
        { name: 'feat/one', sha: firstSha }, { name: 'feat/two', sha: secondSha },
      ] } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('valid complete ancestry attests exact local commits', () => fixture(({ dir, manifest }) => {
  assert.deepEqual(verifyIntegrationStack(manifest, dir).failures, []);
}));

test('detects moved main and changed branch head', () => fixture(({ dir, manifest, baseSha }) => {
  git(dir, 'branch', '-f', 'feat/one', baseSha);
  assert.match(verifyIntegrationStack(manifest, dir).failures.join('\n'), /Head changed/);
  git(dir, 'switch', '-q', 'main');
  writeFileSync(join(dir, 'a.txt'), 'new main\n'); git(dir, 'commit', '-qam', 'main move');
  assert.match(verifyIntegrationStack(manifest, dir).failures.join('\n'), /Main moved/);
}));

test('rejects dirty checkout and missing branches', () => fixture(({ dir, manifest }) => {
  writeFileSync(join(dir, 'untracked'), 'not safe');
  assert.match(verifyIntegrationStack(manifest, dir).failures.join('\n'), /dirty/);
  rmSync(join(dir, 'untracked'));
  manifest.steps[1].name = 'feat/not-here';
  assert.match(verifyIntegrationStack(manifest, dir).failures.join('\n'), /Missing local branch/);
}));

test('rejects unsafe names, invalid SHA, duplicate step and empty list', () => fixture(({ manifest }) => {
  for (const bad of ['../bad', '-x', 'foo//bar', 'a b', 'bad.lock', 'trailing/']) {
    assert.throws(() => validateManifest({ ...manifest, steps: [{ name: bad, sha: manifest.baseSha }] }));
  }
  assert.throws(() => validateManifest({ ...manifest, steps: [] }));
  assert.throws(() => validateManifest({ ...manifest, steps: [manifest.steps[0], manifest.steps[0]] }));
  assert.throws(() => validateManifest({ ...manifest, baseSha: 'main' }));
}));
