/**
 * Validate fields dereferenced by the workflow UI from read-only API data.
 * This is a structural boundary, not a full server domain schema.
 */
type RecordValue = Record<string, unknown>;

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string';
}

function version(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function nullableText(value: unknown): boolean {
  return value === null || text(value);
}

function arrayOf(value: unknown, guard: (item: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(guard);
}

function summaryStage(value: unknown): boolean {
  return record(value) && nullableText(value.taskId) && text(value.agentId);
}

function summary(value: unknown): boolean {
  return (
    record(value) &&
    text(value.id) &&
    text(value.repositoryId) &&
    text(value.state) &&
    version(value.version) &&
    arrayOf(value.stages, summaryStage)
  );
}

function timelineStage(value: unknown): boolean {
  return (
    record(value) &&
    text(value.kind) &&
    text(value.status) &&
    text(value.agentId) &&
    text(value.mode) &&
    version(value.agentRevision) &&
    nullableText(value.nextAction)
  );
}

function timeline(value: unknown): boolean {
  return (
    record(value) &&
    text(value.id) &&
    version(value.version) &&
    text(value.state) &&
    text(value.notice) &&
    arrayOf(value.stages, timelineStage)
  );
}

function report(value: unknown): boolean {
  return record(value) && text(value.kind) && text(value.result) && nullableText(value.error);
}

function finding(value: unknown): boolean {
  return (
    record(value) &&
    text(value.code) &&
    text(value.severity) &&
    nullableText(value.stage) &&
    text(value.message) &&
    nullableText(value.suggestedAction)
  );
}

function diagnostics(value: unknown): boolean {
  return (
    record(value) &&
    text(value.id) &&
    version(value.version) &&
    text(value.state) &&
    text(value.warning) &&
    arrayOf(value.findings, finding)
  );
}

function dashboardTask(value: unknown): boolean {
  return (
    record(value) &&
    text(value.id) &&
    text(value.title) &&
    text(value.repositoryId) &&
    text(value.agentId) &&
    text(value.state)
  );
}

function dashboardQueueEntry(value: unknown): boolean {
  return record(value) && text(value.taskId);
}

function dashboardProfile(value: unknown): boolean {
  return (
    record(value) &&
    text(value.id) &&
    text(value.name) &&
    typeof value.archived === 'boolean' &&
    text(value.maximumMode)
  );
}

function dashboard(value: unknown): boolean {
  return (
    record(value) &&
    arrayOf(value.tasks, dashboardTask) &&
    arrayOf(value.queue, dashboardQueueEntry) &&
    (value.profiles === undefined || arrayOf(value.profiles, dashboardProfile))
  );
}

function qaCommand(value: unknown): boolean {
  return record(value) && text(value.commandId) && arrayOf(value.argv, text);
}

function qaCommands(value: unknown): boolean {
  return record(value) && arrayOf(value.commands, qaCommand);
}

/**
 * The board only performs these GETs. Mutations retain the server's
 * optimistic-version guards and do not pass through this read-only check.
 */
export function assertWorkflowReadShape(path: string, value: unknown): void {
  let valid: boolean;
  let label: string;
  if (path === '/workflows') {
    valid = arrayOf(value, summary);
    label = 'workflow list';
  } else if (path === '/dashboard') {
    valid = dashboard(value);
    label = 'dashboard';
  } else if (path === '/workflows/qa-commands') {
    valid = qaCommands(value);
    label = 'QA command catalog';
  } else if (/^\/workflows\/[^/]+\/timeline$/.test(path)) {
    valid = timeline(value);
    label = 'workflow timeline';
  } else if (/^\/workflows\/[^/]+\/results$/.test(path)) {
    valid = arrayOf(value, report);
    label = 'workflow reports';
  } else if (/^\/workflows\/[^/]+\/diagnostics$/.test(path)) {
    valid = diagnostics(value);
    label = 'workflow diagnostics';
  } else {
    throw new Error('Unrecognized workflow read endpoint');
  }
  if (!valid) throw new Error(`Invalid workflow response: malformed ${label}`);
}
