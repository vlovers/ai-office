/**
 * Pure GitHub remote classification. No Git subprocess or network access.
 * Never include an untrusted remote string in UI, logs or error messages:
 * HTTPS userinfo can contain credentials.
 */
export type GitHubRemote = {
  host: 'github.com';
  owner: string;
  repository: string;
  url: string;
};

const slug = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const repoSlug = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

export function parseGitHubRemote(input: string): GitHubRemote | null {
  if (input.length > 2048 || /[\u0000-\u001f\u007f]/.test(input)) return null;
  let owner = '';
  let repository = '';
  const ssh = /^git@github\.com:([^/]+)\/([^/]+)$/.exec(input);
  if (ssh) {
    owner = ssh[1];
    repository = ssh[2];
  } else {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return null;
    }
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'github.com' ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) return null;
    const parts = url.pathname.split('/');
    if (parts.length !== 3 || parts[0] !== '') return null;
    owner = parts[1];
    repository = parts[2];
  }
  repository = repository.replace(/\.git$/, '');
  if (!slug.test(owner) || !repoSlug.test(repository) || owner === '.' || owner === '..') {
    return null;
  }
  return {
    host: 'github.com',
    owner,
    repository,
    url: 'https://github.com/' + owner + '/' + repository,
  };
}
