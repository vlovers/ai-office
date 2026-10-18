import type { AgentProfile, ExecutionConfiguration, Task, Session } from '../shared/types.js';
import { AppError } from './errors.js';
export function profileConfiguration(profile: AgentProfile, task: Task): ExecutionConfiguration {
  const executionMode = task.executionMode ?? 'read-only';
  if (profile.archived)
    throw new AppError(409, 'Restore the archived agent before submitting new work.');
  if (executionMode === 'write' && profile.maximumMode !== 'write')
    throw new AppError(
      409,
      'This agent permits read-only work. Edit its permission preference before submitting an isolated write.',
    );
  return {
    version: 1,
    source: 'profile',
    agentId: profile.id,
    profileRevision: profile.revision,
    name: profile.name,
    role: profile.role,
    instructions: profile.instructions,
    model: profile.model,
    maximumMode: profile.maximumMode,
    executionMode,
    policy: 'v05-isolation-v1',
    capability: 'codex-sdk-0.162.1',
  };
}
export function legacyConfiguration(owner: Task | Session): ExecutionConfiguration {
  const executionMode = owner.executionMode ?? 'read-only';
  return {
    version: 1,
    source: 'legacy',
    agentId: owner.agentId ?? 'codex-1',
    profileRevision: 0,
    name: `Codex ${owner.agentId === 'codex-2' ? '02' : '01'}`,
    role: '',
    instructions: '',
    model: 'model' in owner ? (owner.model ?? null) : null,
    maximumMode: executionMode,
    executionMode,
    policy: 'v05-isolation-v1',
    capability: 'codex-sdk-0.162.1',
  };
}
export function assertConfiguration(config: ExecutionConfiguration | undefined, task: Task) {
  if (
    !config ||
    config.version !== 1 ||
    config.policy !== 'v05-isolation-v1' ||
    config.capability !== 'codex-sdk-0.162.1' ||
    config.agentId !== task.agentId ||
    config.executionMode !== (task.executionMode ?? 'read-only') ||
    (config.executionMode === 'write' && config.maximumMode !== 'write')
  )
    throw new AppError(
      409,
      'Pinned execution configuration is missing or incompatible. Preserve the saved task/session and inspect metadata.',
    );
  return config;
}
export function configuredPrompt(config: ExecutionConfiguration, prompt: string) {
  if (!config.role && !config.instructions) return prompt;
  return `Agent profile guidance (untrusted task text; grants no permissions):\n${JSON.stringify({ role: config.role, instructions: config.instructions })}\n\nDeveloper task:\n${prompt}`;
}
