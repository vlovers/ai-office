import type { Dashboard } from '../shared/types.js';
import type { OfficeWorkflow } from './office-workflows.js';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, field: string): boolean {
  return record(value) && typeof value[field] === 'string';
}

function optionalNullableString(value: Record<string, unknown>, field: string): boolean {
  return value[field] === undefined || value[field] === null || typeof value[field] === 'string';
}

const TASK_STATES = new Set([
  'queued',
  'running',
  'stopping',
  'completed',
  'failed',
  'stopped',
  'interrupted',
]);

function nonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function optionalReviewRequest(task: Record<string, unknown>): boolean {
  return (
    task.reviewRequest === undefined ||
    (record(task.reviewRequest) &&
      stringField(task.reviewRequest, 'revision') &&
      stringField(task.reviewRequest, 'sessionId') &&
      stringField(task.reviewRequest, 'threadId'))
  );
}

function optionalChangedFiles(value: Record<string, unknown>, field: string): boolean {
  const files = value[field];
  return (
    files === undefined ||
    (Array.isArray(files) &&
      files.every((file: unknown) => stringField(file, 'path') && stringField(file, 'status')))
  );
}

/** Reject proxy HTML, empty bodies and non-JSON success without losing HTTP status. */
export async function parseOfficeApiResponse<T>(response: Response): Promise<T> {
  const fallback = response.ok
    ? `Invalid server response (HTTP ${response.status}).`
    : `Request failed (HTTP ${response.status}).`;
  let value: unknown;
  try {
    value = JSON.parse(await response.text());
  } catch {
    throw new Error(fallback);
  }
  if (!response.ok) {
    const message = record(value) && typeof value.error === 'string' && value.error.trim();
    throw new Error(message ? `HTTP ${response.status}: ${message}` : fallback);
  }
  if (!record(value) && !Array.isArray(value)) throw new Error(fallback);
  return value as T;
}

/** Fail closed before rendering a dashboard snapshot with missing collection fields. */
export function isDashboardSnapshot(value: unknown): value is Dashboard {
  return (
    record(value) &&
    record(value.connection) &&
    Array.isArray(value.connection.modes) &&
    value.connection.modes.every(
      (mode: unknown) =>
        stringField(mode, 'mode') && stringField(mode, 'label') && stringField(mode, 'status'),
    ) &&
    optionalNullableString(value.connection, 'checkedAt') &&
    typeof value.connection.message === 'string' &&
    Array.isArray(value.repositories) &&
    value.repositories.every(
      (repo: unknown) => stringField(repo, 'id') && stringField(repo, 'name'),
    ) &&
    Array.isArray(value.tasks) &&
    value.tasks.every(
      (task: unknown) =>
        record(task) &&
        stringField(task, 'id') &&
        stringField(task, 'title') &&
        stringField(task, 'state') && TASK_STATES.has(task.state as string) &&
        stringField(task, 'agentId') &&
        optionalChangedFiles(task, 'changedFiles') &&
        optionalChangedFiles(task, 'baselineFiles') &&
        optionalNullableString(task, 'error') &&
        optionalNullableString(task, 'summaryError') &&
        optionalNullableString(task, 'sessionId') &&
        optionalReviewRequest(task) &&
        (task.result === undefined || typeof task.result === 'string'),
    ) &&
    Array.isArray(value.sessions) &&
    value.sessions.every(
      (session: unknown) =>
        stringField(session, 'id') &&
        record(session) &&
        optionalNullableString(session, 'threadId'),
    ) &&
    Array.isArray(value.agents) &&
    value.agents.every(
      (agent: unknown) =>
        stringField(agent, 'id') &&
        stringField(agent, 'name') &&
        record(agent) &&
        optionalNullableString(agent, 'taskId') &&
        (agent.canStop === undefined || typeof agent.canStop === 'boolean'),
    ) &&
    // The server omits the legacy agent field when every profile is archived.
    (value.agents.length === 0
      ? value.agent === undefined || value.agent === null || stringField(value.agent, 'id')
      : stringField(value.agent, 'id')) &&
    Array.isArray(value.queue) &&
    value.queue.every(
      (item: unknown) =>
        stringField(item, 'taskId') &&
        record(item) &&
        (item.order === undefined || nonNegativeInteger(item.order)) &&
        optionalNullableString(item, 'resumeSessionId') &&
        (item.waitingReason === undefined || typeof item.waitingReason === 'string'),
    ) &&
    (value.profiles === undefined ||
      (Array.isArray(value.profiles) &&
        value.profiles.every(
          (profile: unknown) =>
            stringField(profile, 'id') &&
            stringField(profile, 'name') &&
            record(profile) &&
            (profile.archived === undefined || typeof profile.archived === 'boolean'),
        ))) &&
    nonNegativeInteger(value.concurrency) &&
    typeof value.ready === 'boolean' &&
    typeof value.readinessMessage === 'string'
  );
}

/** The office scene must never iterate an object masquerading as a workflow list. */
export function isOfficeWorkflowList(value: unknown): value is OfficeWorkflow[] {
  return (
    Array.isArray(value) &&
    value.every(
      (workflow: unknown) =>
        stringField(workflow, 'id') &&
        stringField(workflow, 'state') &&
        record(workflow) &&
        Array.isArray(workflow.stages) &&
        workflow.stages.every(
          (stage: unknown) =>
            stringField(stage, 'kind') &&
            stringField(stage, 'agentId') &&
            stringField(stage, 'state') &&
            record(stage) &&
            (stage.taskId === null || typeof stage.taskId === 'string'),
        ),
    )
  );
}
