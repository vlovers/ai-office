import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from './errors.js';
import type { Store } from './store.js';
import type { AuthMode } from '../shared/types.js';

export type WorkflowStageKind = 'coder' | 'reviewer' | 'qa';
export type WorkflowStageState =
  | 'pending'
  | 'awaiting_approval'
  | 'ready'
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'blocked';
export type WorkflowState = 'active' | 'completed' | 'cancelled' | 'blocked';

export interface WorkflowStage {
  kind: WorkflowStageKind;
  agentId: string;
  agentRevision: number;
  mode: 'read-only' | 'write';
  state: WorkflowStageState;
  taskId: string | null;
  approvedRevision: string | null;
  outputRevision: string | null;
  approvedAt: string | null;
}
export interface Workflow {
  id: string;
  repositoryId: string;
  workspaceId: string | null;
  baselineRevision: string;
  version: number;
  state: WorkflowState;
  stages: WorkflowStage[];
  createdAt: string;
  updatedAt: string;
}
export interface NewWorkflow {
  repositoryId: string;
  workspaceId?: string | null;
  baselineRevision: string;
  stages: Array<Pick<WorkflowStage, 'kind' | 'agentId' | 'agentRevision' | 'mode'>>;
}

/**
 * Persistent workflow checkpoints. This layer NEVER starts an agent, runs Git,
 * infers permissions, or grants host verification rights. The caller must
 * revalidate the workspace identity, revision and operator authorization.
 */
export class WorkflowStore {
  constructor(private readonly db: DatabaseSync) {}

  list(): Workflow[] {
    return this.db
      .prepare('SELECT json FROM workflows ORDER BY created_at DESC, id DESC')
      .all()
      .map((row) => JSON.parse(String(row.json)) as Workflow);
  }

  get(id: string): Workflow | undefined {
    const row = this.db.prepare('SELECT json FROM workflows WHERE id=?').get(id);
    return row ? (JSON.parse(String(row.json)) as Workflow) : undefined;
  }

  private require(id: string): Workflow {
    const workflow = this.get(id);
    if (!workflow) throw new AppError(404, 'Unknown workflow.');
    return workflow;
  }

  create(input: NewWorkflow): Workflow {
    if (!this.db.prepare('SELECT id FROM repositories WHERE id=?').get(input.repositoryId))
      throw new AppError(404, 'Unknown repository.');
    if (!/^[0-9a-f]{40,64}$/i.test(input.baselineRevision))
      throw new AppError(400, 'Expected an exact Git revision.');
    if (input.workspaceId) {
      const workspace = this.db
        .prepare('SELECT json FROM workspaces WHERE id=?')
        .get(input.workspaceId);
      if (
        !workspace ||
        (JSON.parse(String(workspace.json)) as { repositoryId: string }).repositoryId !==
          input.repositoryId
      )
        throw new AppError(409, 'Workspace does not belong to repository.');
    }
    if (
      input.stages.length < 2 ||
      input.stages.length > 3 ||
      input.stages[0]?.kind !== 'coder' ||
      input.stages[1]?.kind !== 'reviewer' ||
      (input.stages[2] && input.stages[2].kind !== 'qa') ||
      input.stages[0]?.mode !== 'write' ||
      input.stages.slice(1).some((stage) => stage.mode !== 'read-only')
    )
      throw new AppError(
        400,
        'Expected Coder (write), Reviewer (read-only), optional QA (read-only).',
      );
    for (const stage of input.stages) {
      if (!stage.agentId || !Number.isSafeInteger(stage.agentRevision) || stage.agentRevision < 1)
        throw new AppError(400, 'Invalid agent revision.');
      const agent = this.db
        .prepare('SELECT json FROM agent_versions WHERE agent_id=? AND revision=?')
        .get(stage.agentId, stage.agentRevision);
      if (!agent) throw new AppError(409, 'Pinned agent revision not found.');
      const profile = JSON.parse(String(agent.json)) as { maximumMode: string };
      if (stage.mode === 'write' && profile.maximumMode !== 'write')
        throw new AppError(403, 'Agent profile does not authorize writes.');
    }
    const at = new Date().toISOString();
    const workflow: Workflow = {
      id: randomUUID(),
      repositoryId: input.repositoryId,
      workspaceId: input.workspaceId ?? null,
      baselineRevision: input.baselineRevision,
      version: 0,
      state: 'active',
      createdAt: at,
      updatedAt: at,
      stages: input.stages.map((stage, index) => ({
        ...stage,
        state: index === 0 ? 'awaiting_approval' : 'pending',
        taskId: null,
        approvedRevision: null,
        outputRevision: null,
        approvedAt: null,
      })),
    };
    this.db
      .prepare('INSERT INTO workflows(id,repository_id,created_at,json) VALUES (?,?,?,?)')
      .run(workflow.id, workflow.repositoryId, at, JSON.stringify(workflow));
    return workflow;
  }

  /**
   * Atomically bind an existing, unsubmitted task to an approved stage.
   * No model starts here. Dispatch remains exclusive to TaskManager.
   */
  bindApprovedTask(id: string, expectedVersion: number, taskId: string): Workflow {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.require(id);
      if (current.state !== 'active' || current.version !== expectedVersion)
        throw new AppError(409, 'Workflow has changed or is not active.');
      const next = structuredClone(current);
      const stage = next.stages.find((s) => s.state === 'ready');
      if (!stage || !stage.approvedRevision || next.stages.some((s) => s.taskId === taskId))
        throw new AppError(409, 'No uniquely approved stage available.');
      const row = this.db.prepare('SELECT json FROM tasks WHERE id=?').get(taskId);
      if (!row) throw new AppError(404, 'Task not found.');
      const task = JSON.parse(String(row.json)) as {
        repositoryId: string;
        agentId: string;
        executionMode?: string;
        state: string;
        sessionId: string | null;
      };
      if (
        task.repositoryId !== next.repositoryId ||
        task.agentId !== stage.agentId ||
        (task.executionMode ?? 'read-only') !== stage.mode ||
        task.state !== 'queued' ||
        task.sessionId
      )
        throw new AppError(409, 'Task does not match the approved stage.');
      if (this.db.prepare('SELECT 1 FROM task_queue WHERE task_id=?').get(taskId))
        throw new AppError(409, 'Already submitted tasks cannot be rebound.');
      if (
        this.list().some(
          (workflow) =>
            workflow.id !== id && workflow.stages.some((candidate) => candidate.taskId === taskId),
        )
      )
        throw new AppError(409, 'Task already belongs to another workflow.');
      stage.taskId = taskId;
      // Bound is intentionally NOT running: TaskManager still needs explicit
      // submission, a matching snapshot and workspace/permission checks.
      stage.state = 'ready';
      next.version++;
      next.updatedAt = new Date().toISOString();
      this.db.prepare('UPDATE workflows SET json=? WHERE id=?').run(JSON.stringify(next), id);
      this.db.exec('COMMIT');
      return next;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Make queue submission and stage transition a single SQLite transaction.
   * Call only after TaskManager has validated the exact same task and provider.
   */
  enqueueApprovedTask(
    store: Store,
    id: string,
    expectedVersion: number,
    taskId: string,
    mode: AuthMode,
    confirmedRevision: string,
  ): Workflow {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.require(id);
      if (current.version !== expectedVersion || current.state !== 'active')
        throw new AppError(409, 'Workflow is stale.');
      const next = structuredClone(current);
      const stage = next.stages.find((s) => s.state === 'ready' && s.taskId === taskId);
      if (!stage || !stage.approvedRevision || stage.approvedRevision !== confirmedRevision)
        throw new AppError(409, 'Task is not bound to this approved revision.');
      if (this.list().some((w) => w.id !== id && w.stages.some((s) => s.taskId === taskId)))
        throw new AppError(409, 'Task already belongs to another workflow.');
      const task = store.task(taskId);
      if (
        !task ||
        task.state !== 'queued' ||
        task.repositoryId !== current.repositoryId ||
        task.agentId !== stage.agentId ||
        (task.executionMode ?? 'read-only') !== stage.mode
      )
        throw new AppError(409, 'Bound task changed.');
      const profile = store.agentVersion(stage.agentId, stage.agentRevision);
      if (!profile || (stage.mode === 'write' && profile.maximumMode !== 'write'))
        throw new AppError(403, 'Pinned agent authorization missing.');
      store.enqueue(taskId, mode, undefined, false);
      const snapshot = store.taskConfiguration(taskId);
      if (
        !snapshot ||
        snapshot.profileRevision !== stage.agentRevision ||
        snapshot.agentId !== stage.agentId ||
        snapshot.executionMode !== stage.mode
      )
        throw new AppError(409, 'Execution configuration differs from approved profile.');
      stage.state = 'running'; // includes waiting-in-queue; recover fail-closed after crash
      next.version++;
      next.updatedAt = new Date().toISOString();
      this.db.prepare('UPDATE workflows SET json=? WHERE id=?').run(JSON.stringify(next), id);
      this.db.exec('COMMIT');
      return next;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Reconcile after Store has recovered interrupted tasks. A running stage
   * may not be dispatched again after process death, even when its task
   * still exists in the persistent queue. Preserve evidence for inspection.
   */
  recoverInterrupted(): number {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let changed = 0;
      for (const current of this.list()) {
        if (current.state !== 'active') continue;
        const running = current.stages.filter((stage) => stage.state === 'running');
        if (!running.length) continue;
        const next = structuredClone(current);
        for (const stage of next.stages) {
          if (stage.state !== 'running') continue;
          const row = stage.taskId
            ? this.db.prepare('SELECT state FROM tasks WHERE id=?').get(stage.taskId)
            : undefined;
          if (row?.state === 'running' || row?.state === 'stopping') continue;
          if (row?.state === 'queued' && stage.taskId) {
            // A workflow queue entry must never escape its approval gate after
            // restart. Remove the runnable entry in this same transaction.
            const taskRow = this.db.prepare('SELECT json FROM tasks WHERE id=?').get(stage.taskId);
            if (taskRow) {
              const task = JSON.parse(String(taskRow.json)) as { state: string; error: string | null; updatedAt: string };
              task.state = 'interrupted';
              task.error = 'Workflow execution requires manual review after server restart.';
              task.updatedAt = new Date().toISOString();
              this.db.prepare('UPDATE tasks SET state=?, json=? WHERE id=?')
                .run(task.state, JSON.stringify(task), stage.taskId);
            }
            this.db.prepare('DELETE FROM task_queue WHERE task_id=?').run(stage.taskId);
          }
          stage.state = row?.state === 'completed' ? 'blocked' : 'interrupted';
          next.state = 'blocked';
        }
        if (next.state !== 'blocked') continue;
        next.version++;
        next.updatedAt = new Date().toISOString();
        this.db
          .prepare('UPDATE workflows SET json=? WHERE id=?')
          .run(JSON.stringify(next), next.id);
        changed++;
      }
      this.db.exec('COMMIT');
      return changed;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Terminal task reconciliation is fail-closed: successful Codex completion
   * is NOT proof of an approved Git/worktree revision. Block handoff until
   * a separate verifier captures the exact output evidence.
   */
  reconcileTerminals(): number {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let changed = 0;
      for (const current of this.list()) {
        if (current.state !== 'active') continue;
        const next = structuredClone(current);
        for (const stage of next.stages) {
          if (stage.state !== 'running' || !stage.taskId) continue;
          const row = this.db.prepare('SELECT state FROM tasks WHERE id=?').get(stage.taskId);
          if (!row || !['completed', 'failed', 'stopped', 'interrupted'].includes(String(row.state)))
            continue;
          // A completed task still requires signed-off review evidence. Do
          // not copy an unverified HEAD or blindly approve a next stage.
          stage.state = row.state === 'completed' ? 'blocked' :
            row.state === 'interrupted' ? 'interrupted' : 'failed';
          next.state = 'blocked';
        }
        if (next.state !== 'blocked') continue;
        next.version++;
        next.updatedAt = new Date().toISOString();
        this.db.prepare('UPDATE workflows SET json=? WHERE id=?')
          .run(JSON.stringify(next), next.id);
        changed++;
      }
      this.db.exec('COMMIT');
      return changed;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Optimistic concurrency prevents duplicate actions from two open tabs.
   * A revision supplied by a browser is a claim, NOT independently verified
   * Git evidence; the integration layer must recompute current revision.
   */
  transition(
    id: string,
    expectedVersion: number,
    action:
      | { type: 'approve'; revision: string }
      | { type: 'start'; taskId: string; revision: string }
      | { type: 'finish'; taskId: string; revision: string; succeeded: boolean }
      | { type: 'interrupt'; taskId: string }
      | { type: 'cancel' },
  ): Workflow {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.require(id);
      if (current.version !== expectedVersion) throw new AppError(409, 'Stale workflow version.');
      if (current.state !== 'active') throw new AppError(409, 'Workflow is no longer active.');
      const next: Workflow = structuredClone(current);
      if (action.type === 'cancel') {
        if (next.stages.some((s) => s.state === 'running'))
          throw new AppError(409, 'Stop running task with TaskManager before cancelling workflow.');
        next.state = 'cancelled';
      } else {
        const stage = next.stages.find((s) =>
          action.type === 'approve'
            ? s.state === 'awaiting_approval'
            : action.type === 'start'
              ? s.state === 'ready'
              : s.state === 'running' && s.taskId === action.taskId,
        );
        if (!stage) throw new AppError(409, 'No stage available for this action.');
        if (action.type === 'approve') {
          const predecessor = next.stages[next.stages.indexOf(stage) - 1];
          const expected = predecessor?.outputRevision ?? next.baselineRevision;
          if (action.revision !== expected)
            throw new AppError(409, 'Stage approval revision mismatch.');
          stage.approvedRevision = action.revision;
          stage.approvedAt = new Date().toISOString();
          stage.state = 'ready';
        } else if (action.type === 'start') {
          if (
            !action.taskId ||
            (stage.taskId !== null && stage.taskId !== action.taskId) ||
            action.revision !== stage.approvedRevision
          )
            throw new AppError(409, 'Task or pinned revision mismatch.');
          stage.taskId = action.taskId;
          stage.state = 'running';
        } else if (action.type === 'interrupt') {
          stage.state = 'interrupted';
          next.state = 'blocked';
        } else {
          if (action.revision.length < 40 || !/^[0-9a-f]{40,64}$/i.test(action.revision))
            throw new AppError(400, 'Invalid output revision.');
          if (!action.succeeded) {
            stage.state = 'failed';
            next.state = 'blocked';
          } else {
            stage.state = 'completed';
            stage.outputRevision = action.revision;
            const following = next.stages[next.stages.indexOf(stage) + 1];
            if (following) following.state = 'awaiting_approval';
            else next.state = 'completed';
          }
        }
      }
      next.version++;
      next.updatedAt = new Date().toISOString();
      const updated = this.db
        .prepare('UPDATE workflows SET json=? WHERE id=?')
        .run(JSON.stringify(next), id);
      if (Number(updated.changes) !== 1) throw new AppError(409, 'Workflow disappeared.');
      this.db.exec('COMMIT');
      return next;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
