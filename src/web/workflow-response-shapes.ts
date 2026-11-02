/**
 * Validate the fields the workflow UI dereferences from read-only API data.
 * This is deliberately a structural boundary, not a full server domain schema:
 * reject malformed success payloads before any checkpoint state is committed.
 */
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const version = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const nullableText = (value: unknown): boolean => value === null || text(value);
const arrayOf = (value: unknown, guard: (item: unknown) => boolean): boolean =>
  Array.isArray(value) && value.every(guard);

const summary = (value: unknown): boolean =>
  record(value) &&
  text(value.id) &&
  text(value.repositoryId) &&
  text(value.state) &&
  version(value.version) &&
  arrayOf(value.stages, (stage) =>
    record(stage) && nullableText(stage.taskId) && text(stage.agentId),
  );

const timeline = (value: unknown): boolean =>
  record(value) &&
  text(value.id) &&
  version(value.version) &&
  text(value.state) &&
  text(value.notice) &&
  arrayOf(value.stages, (stage) =>
    record(stage) &&
    text(stage.kind) &&
    text(stage.status) &&
    text(stage.agentId) &&
    text(stage.mode) &&
    version(stage.agentRevision) &&
    nullableText(stage.nextAction),
  );

const report = (value: unknown): boolean =>
  record(value) &&
  text(value.kind) &&
  text(value.result) &&
  nullableText(value.error);

const diagnostics = (value: unknown): boolean =>
  record(value) &&
  text(value.id) &&
  version(value.version) &&
  text(value.state) &&
  text(value.warning) &&
  arrayOf(value.findings, (finding) =>
    record(finding) &&
    text(finding.code) &&
    text(finding.severity) &&
    nullableText(finding.stage) &&
    text(finding.message) &&
    nullableText(finding.suggestedAction),
  );

const dashboard = (value: unknown): boolean =>
  record(value) &&
  arrayOf(value.tasks, (task) =>
    record(task) &&
    text(task.id) &&
    text(task.title) &&
    text(task.repositoryId) &&
    text(task.agentId) &&
    text(task.state),
  ) &&
  arrayOf(value.queue, (entry) => record(entry) && text(entry.taskId)) &&
  (value.profiles === undefined ||
    arrayOf(value.profiles, (profile) =>
      record(profile) &&
      text(profile.id) &&
      text(profile.name) &&
      typeof profile.archived === 'boolean' &&
      text(profile.maximumMode),
    ));

const qaCommands = (value: unknown): boolean =>
  record(value) &&
  arrayOf(value.commands, (command) =>
    record(command) &&
    text(command.commandId) &&
    arrayOf(command.argv, text),
  );

/**
 * The workflow board only performs these GETs. Mutations are intentionally
 * outside this check and retain the server's own optimistic-version guards.
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
