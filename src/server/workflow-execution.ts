import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Store } from './store.js';
import type { Workspaces } from './workspaces.js';
import type { Workflow, WorkflowStage } from './workflows.js';
import { AppError } from './errors.js';
import { git, repositoryLeaseDirectories } from './repositories.js';
import { acquireLocks } from './lock.js';
import { verifyEvidenceBundle, type SnapshotManifest } from './evidence-bundle.js';
import { verifyReviewerSourceCandidate, type ReviewerSourceManifest } from './reviewer-source.js';
import { verifyReviewerGitContext } from './reviewer-runtime.js';

export function workflowSource(store: Store, workflow: Workflow) {
  const coder = workflow.stages[0];
  const task = coder?.taskId ? store.task(coder.taskId) : undefined;
  const repository = store.repository(workflow.repositoryId);
  const workspace = task?.workspaceId ? store.workspace(task.workspaceId) : undefined;
  if (
    !coder?.evidence ||
    task?.state !== 'completed' ||
    !repository ||
    !workspace ||
    workspace.id !== coder.evidence.workspaceId ||
    task.repositoryId !== repository.id ||
    workspace.decision !== 'pending' ||
    workspace.operation ||
    workspace.recoveryError
  )
    throw new AppError(409, 'Approved Coder workspace is unavailable or changed.');
  return { coder, task, repository, workspace };
}

export async function acquireWorkflowLease(store: Store, workflow: Workflow) {
  const { repository, workspace } = workflowSource(store, workflow);
  const root = join('/tmp', `ai-office-worktrees-${process.getuid?.() ?? 'local'}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directories = await repositoryLeaseDirectories(repository, workspace.gitDir);
  if (workflow.stages[1]?.runtimeCandidate)
    directories.push(join(workflow.stages[1].runtimeCandidate.directory, '.git'));
  return acquireLocks(
    directories.map((path) => join(root, createHash('sha256').update(path).digest('hex'))),
    repository.path,
  );
}

/** Caller holds source, repository and runtime leases until process cleanup and result persistence. */
export async function validateWorkflowSnapshot(
  store: Store,
  workspaces: Workspaces,
  workflow: Workflow,
) {
  const { coder, repository, workspace } = workflowSource(store, workflow);
  const reviewer = workflow.stages[1];
  const source = reviewer?.sourceCandidate;
  const runtime = reviewer?.runtimeCandidate;
  const bundle = reviewer?.bundle;
  if (
    !source ||
    !runtime ||
    !bundle ||
    source.digest !== runtime.sourceDigest ||
    [source.revision, runtime.revision, bundle.revision, reviewer.approvedRevision].some(
      (revision) => revision !== coder.evidence!.revision,
    )
  )
    throw new AppError(409, 'Approved snapshot provenance is incomplete.');
  await workspaces.validateExecution(repository, workspace);
  if (
    (await git(repository.path, ['rev-parse', 'HEAD'])).trim() !== workflow.baselineRevision ||
    (await git(repository.path, ['status', '--porcelain', '--untracked-files=all'])).trim()
  )
    throw new AppError(409, 'Primary checkout changed since workflow approval.');
  if ((await workspaces.revision(repository, workspace)) !== coder.evidence!.revision)
    throw new AppError(409, 'Coder evidence changed after approval.');
  const root = await workspaces.authorize(repository);
  for (const [directory, category] of [
    [source.directory, 'workflow-reviewer-source'],
    [runtime.directory, 'workflow-reviewer-runtime'],
    [bundle.directory, 'workflow-evidence'],
  ]) {
    if (
      !directory ||
      directory !== join(root, category!, basename(directory)) ||
      !/^[0-9a-f-]{36}$/.test(basename(directory)) ||
      (await realpath(directory)) !== directory
    )
      throw new AppError(409, 'Snapshot directory identity changed.');
  }
  const manifest = JSON.parse(
    await readFile(join(source.directory, 'source-manifest.json'), 'utf8'),
  ) as ReviewerSourceManifest;
  const evidence = JSON.parse(
    await readFile(join(bundle.directory, 'manifest.json'), 'utf8'),
  ) as SnapshotManifest;
  if (
    manifest.digest !== source.digest ||
    manifest.revision !== coder.evidence!.revision ||
    manifest.files.length !== source.fileCount ||
    evidence.digest !== bundle.digest ||
    evidence.id !== bundle.id ||
    evidence.evidenceRevision !== coder.evidence!.revision ||
    evidence.entries.length !== coder.evidence!.fileCount ||
    !(await verifyEvidenceBundle(bundle.directory, evidence)) ||
    !(await verifyReviewerSourceCandidate(source.directory, manifest)) ||
    !(await verifyReviewerGitContext({
      destinationRoot: join(root, 'workflow-reviewer-runtime'),
      directory: runtime.directory,
      commit: runtime.commit,
      manifest,
    }))
  )
    throw new AppError(409, 'Snapshot integrity verification failed.');
  const files = new Map(manifest.files.map((file) => [file.path, file]));
  if (
    evidence.entries.some((entry) =>
      entry.status === 'D'
        ? files.has(entry.path)
        : files.get(entry.path)?.sha256 !== entry.sha256 ||
          files.get(entry.path)?.size !== entry.size,
    )
  )
    throw new AppError(409, 'Source snapshot differs from approved changed-file evidence.');
  const stat = await lstat(runtime.directory, { bigint: true });
  const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
  for (const stage of workflow.stages.slice(1)) {
    if (
      stage.execution &&
      (stage.execution.runtimeIdentity !== identity ||
        stage.execution.sourceDigest !== source.digest ||
        stage.execution.revision !== source.revision)
    )
      throw new AppError(409, 'Execution snapshot identity changed.');
  }
  return {
    directory: runtime.directory,
    sourceDigest: source.digest,
    revision: source.revision,
    runtimeIdentity: identity,
  };
}

export function resultDigest(stage: WorkflowStage, result: string) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        taskId: stage.taskId,
        execution: stage.execution,
        qaPlan: stage.qaPlan,
        result,
      }),
    )
    .digest('hex');
}
