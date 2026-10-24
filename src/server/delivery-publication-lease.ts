import { acquireLocks } from './lock.js';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { repositoryLeaseDirectories } from './repositories.js';
import {
  validateLeasedPublication,
  type PublicationReadiness,
} from './delivery-publication-coordinator.js';
import type { DeliveryPublicationPlan } from './delivery-publication-policy.js';

type RepositoryIdentity = { path: string; gitDir: string };

/**
 * The single cross-instance Git lock namespace shared by publication,
 * recovery and normal AI Office Git mutations. No stale lock is stolen.
 */
export async function withDeliveryRepositoryLease<T>(
  repository: RepositoryIdentity,
  workspaceGitDir: string,
  action: () => Promise<T>,
): Promise<T> {
  const directories = await repositoryLeaseDirectories(repository, workspaceGitDir);
  const lockRoot = join('/tmp', `ai-office-worktrees-${process.getuid?.() ?? 'local'}`);
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const release = await acquireLocks(
    directories.map((directory) =>
      join(lockRoot, createHash('sha256').update(directory).digest('hex')),
    ),
    'AI Office delivery publication/recovery',
  );
  try {
    return await action();
  } finally {
    await release();
  }
}

/**
 * Cross-instance Git metadata lease with an exact review-snapshot check.
 * The callback must not publish anything until it has independently verified
 * the current workspace identity, journal state and remote destination.
 */
export async function withPublicationLease<T>(
  repository: RepositoryIdentity,
  workspaceGitDir: string,
  readiness: PublicationReadiness,
  refreshPlan: () => Promise<DeliveryPublicationPlan>,
  action: (plan: Extract<DeliveryPublicationPlan, { allowed: true }>) => Promise<T>,
): Promise<T> {
  if (readiness.status !== 'requires-lease')
    throw new Error('Publication does not require a new lease.');
  return withDeliveryRepositoryLease(repository, workspaceGitDir, async () => {
    const currentPlan = await refreshPlan();
    const result = validateLeasedPublication(readiness.operationKey, currentPlan);
    if (!result.valid) throw new Error(result.reason);
    if (!currentPlan.allowed) throw new Error('Publication plan became blocked.');
    return action(currentPlan);
  });
}
