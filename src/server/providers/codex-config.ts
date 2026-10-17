import type { CodexOptions, ThreadOptions } from '@openai/codex-sdk';

export function codexOptions(
  repositoryPath: string,
  env: Record<string, string>,
  executable?: string,
  write = false,
): CodexOptions {
  const filesystem = {
    ':root': 'deny',
    ':minimal': 'read',
    ':tmpdir': 'deny',
    ':slash_tmp': 'deny',
    [repositoryPath]: {
      '.': write ? 'write' : 'read',
      '.git': 'deny',
      '.codex': 'deny',
      '.agents': 'deny',
      '.aws': 'deny',
      '**/.git': 'deny',
      '**/.git/**': 'deny',
      '**/.codex': 'deny',
      '**/.codex/**': 'deny',
      '**/.agents': 'deny',
      '**/.agents/**': 'deny',
      '**/.aws': 'deny',
      '**/.aws/**': 'deny',
      '.env': 'deny',
      '**/.env*': 'deny',
      '**/*.pem': 'deny',
      '**/credentials*': 'deny',
      '**/auth.json': 'deny',
    },
    glob_scan_max_depth: 32,
  };
  return {
    env,
    ...(executable ? { codexPathOverride: executable } : {}),
    config: {
      default_permissions: 'ai-office-review',
      permissions: { 'ai-office-review': { network: { enabled: false } } },
      approval_policy: 'on-request',
      approvals_reviewer: 'user',
      allow_login_shell: false,
      project_doc_max_bytes: 0,
      shell_environment_policy: { inherit: 'none', set: { PATH: '/usr/bin:/bin' } },
      features: { multi_agent: false, apps: false },
    },
    // This exact table is atomic; it cannot accidentally become dotted path fragments.
    configOverrides: [
      `permissions.ai-office-review.filesystem=${toml(filesystem)}`,
      `projects.${JSON.stringify(repositoryPath)}.trust_level="untrusted"`,
    ],
  };
}
function toml(value: unknown): string {
  if (typeof value === 'object' && value !== null)
    return `{${Object.entries(value)
      .map(([key, child]) => `${JSON.stringify(key)}=${toml(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function threadOptions(repositoryPath: string): ThreadOptions {
  // Do NOT set sandboxMode/networkAccessEnabled: legacy --sandbox overrides the restrictive profile.
  return {
    workingDirectory: repositoryPath,
    skipGitRepoCheck: false,
    webSearchMode: 'disabled',
    approvalPolicy: 'on-request',
  };
}
