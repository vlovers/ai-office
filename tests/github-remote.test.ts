import { describe, expect, it } from 'vitest';
import { parseGitHubRemote } from '../src/shared/github-remote.js';

describe('GitHub remote classification', () => {
  it('accepts HTTPS and SSH GitHub remotes without network access', () => {
    expect(parseGitHubRemote('https://github.com/vlovers/ai-office.git')).toEqual({
      host: 'github.com',
      owner: 'vlovers',
      repository: 'ai-office',
      url: 'https://github.com/vlovers/ai-office',
    });
    expect(parseGitHubRemote('git@github.com:vlovers/ai-office.git')?.url).toBe(
      'https://github.com/vlovers/ai-office',
    );
  });

  it('rejects credentials, redirects, extra paths and unsafe schemes', () => {
    for (const remote of [
      'https://user:token@github.com/owner/repo',
      'https://github.com.evil.example/owner/repo',
      'http://github.com/owner/repo',
      'file:///tmp/repo',
      'https://github.com/owner/repo?token=secret',
      'https://github.com/owner/repo#secret',
      'https://github.com:444/owner/repo',
      'https://github.com/owner/repo/extra',
      'git@evil.example:owner/repo',
      'ssh://git@github.com/owner/repo',
      'https://github.com/owner/repo%2Fextra',
      'https://github.com/owner/repo\\n',
      'https://github.com/owner/..',
      'https://github.com/owner/.git',
      'git@github.com:owner/.',
      'git@github.com:owner/..',
      'git@github.com:./repo',
      'git@github.com:../repo',
      '',
    ]) {
      expect(parseGitHubRemote(remote), remote).toBeNull();
    }
  });

  it('never echoes unsafe inputs into results', () => {
    expect(parseGitHubRemote('https://token@github.com/owner/repo')).toBeNull();
    expect(parseGitHubRemote('https://github.com/owner/repo.git')?.url).toBe(
      'https://github.com/owner/repo',
    );
  });
});
