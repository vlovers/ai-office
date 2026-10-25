import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const SHA_ACTION = /^(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+@[a-f0-9]{40}$/;
const SHA_DOCKER = /^docker:\/\/[A-Za-z0-9_.:/-]+@sha256:[a-f0-9]{64}$/;
const LOCAL_ACTION = /^\.\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/;
const PERMISSIONS_DECLARATION = /^(\s*)permissions\s*:\s*(.*?)\s*(?:#.*)?$/;
const TOKEN_PERMISSION = /^\s*([a-z-]+)\s*:\s*(read|write|none)\s*(?:#.*)?$/;
const USES_DECLARATION = /^\s*(?:-\s*)?uses\s*:\s*(.*?)\s*(?:#.*)?$/;
const CREDENTIAL_SETTING = /^\s*persist-credentials\s*:\s*(.*?)\s*(?:#.*)?$/;
const UNSUPPORTED_QUOTED_KEY =
  /^\s*(?:-\s*)?["'](?:uses|permissions|with|persist-credentials|jobs|steps)["']\s*:/;
const UNSUPPORTED_COMPLEX_KEY = /^\s*(?:-\s*)?\?\s+\S/;
const UNSUPPORTED_FLOW_MAPPING =
  /^\s*(?:-\s*)?(?:"[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)\s*:\s*(?:&[A-Za-z0-9_-]+\s*)?\{/;
const UNSUPPORTED_STANDALONE_FLOW_MAPPING = /^\s*\{/;
const YAML_MERGE_KEY = /^\s*(?:-\s*)?(?:<<|["']<<["'])\s*:/;
const STRUCTURAL_DECLARATION = /^\s*(?:jobs|steps)\s*:\s*(.*?)\s*(?:#.*)?$/;
const FLOW_MAPPING_ITEM = /^\s*-\s*\{/;
// YAML anchors, aliases and explicit tags can decorate mapping nodes and hide
// action references from a line-oriented `uses:` scan (e.g. `- &step uses:`).
// Reject node properties rather than treating an uninspected step as safe.
const UNSUPPORTED_YAML_NODE_PROPERTIES =
  /(?:^\s*(?:-\s*)?|:\s*)(?:&[A-Za-z0-9_-]+|\*[A-Za-z0-9_-]+|!![A-Za-z0-9_-]+)(?=\s|$)/;

function indentation(line) {
  return /^\s*/.exec(line)[0].length;
}

function hasTraversal(path) {
  return path.split('/').some((segment) => segment === '.' || segment === '..');
}

function isSafeReference(reference) {
  if (reference.startsWith('./')) {
    return LOCAL_ACTION.test(reference) && !hasTraversal(reference.slice(2));
  }
  if (reference.startsWith('docker://')) {
    const image = reference.slice('docker://'.length).split('@')[0];
    return SHA_DOCKER.test(reference) && !hasTraversal(image);
  }
  return SHA_ACTION.test(reference) && !hasTraversal(reference.split('@')[0]);
}

export function auditWorkflowText(source, filename = 'workflow') {
  const findings = [];
  const lines = source.split(/\r?\n/);
  let topLevelPermissions = false;

  // Fail closed on YAML forms this line-oriented scanner cannot safely inspect.
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const location = filename + ':' + (index + 1);
    if (
      UNSUPPORTED_QUOTED_KEY.test(line) ||
      UNSUPPORTED_COMPLEX_KEY.test(line) ||
      YAML_MERGE_KEY.test(line) ||
      FLOW_MAPPING_ITEM.test(line) ||
      UNSUPPORTED_FLOW_MAPPING.test(line) ||
      UNSUPPORTED_STANDALONE_FLOW_MAPPING.test(line) ||
      UNSUPPORTED_YAML_NODE_PROPERTIES.test(line)
    ) {
      findings.push(location + ': unsupported YAML syntax for security-sensitive workflow keys');
    }
    const structure = STRUCTURAL_DECLARATION.exec(line);
    if (structure && structure[1].trim()) {
      findings.push(location + ': jobs and steps must use explicit block mappings/sequences');
    }
  }

  // This intentionally accepts only explicit, static read-only token mappings.
  // It is a workflow guard, not a general-purpose YAML parser.
  for (let index = 0; index < lines.length; index += 1) {
    const match = PERMISSIONS_DECLARATION.exec(lines[index]);
    if (!match) continue;
    const depth = indentation(lines[index]);
    const location = filename + ':' + (index + 1);
    if (depth === 0) topLevelPermissions = true;
    if (match[2]) {
      findings.push(location + ': permissions must be an explicit mapping');
      continue;
    }
    let hasContentsRead = false;
    for (let line = index + 1; line < lines.length; line += 1) {
      if (!lines[line].trim() || /^\s*#/.test(lines[line])) continue;
      if (indentation(lines[line]) <= depth) break;
      const entry = TOKEN_PERMISSION.exec(lines[line]);
      if (!entry) {
        findings.push(`${filename}:${line + 1}: invalid or dynamic token permission`);
        continue;
      }
      if (entry[2] === 'write') {
        findings.push(`${filename}:${line + 1}: write token permissions require separate review`);
      }
      if (depth === 0 && entry[1] === 'contents' && entry[2] === 'read') {
        hasContentsRead = true;
      }
    }
    if (depth === 0 && !hasContentsRead) {
      findings.push(location + ': workflow requires contents: read');
    }
  }
  if (!topLevelPermissions) {
    findings.push(filename + ': missing top-level permissions: contents: read');
  }

  for (let index = 0; index < lines.length; index += 1) {
    const match = USES_DECLARATION.exec(lines[index]);
    if (!match) continue;
    const reference = match[1].trim();
    const location = filename + ':' + (index + 1);
    if (!reference || !isSafeReference(reference)) {
      findings.push(
        `${location}: action must use a static local path, immutable commit SHA or Docker digest (${reference})`,
      );
    }
    if (!reference.startsWith('actions/checkout@')) continue;

    const stepIndent = indentation(lines[index]);
    let end = index + 1;
    while (end < lines.length) {
      const nextStep = /^\s*-\s+/.test(lines[end]);
      if (nextStep && indentation(lines[end]) <= stepIndent) break;
      end += 1;
    }

    const credentialSettings = [];
    let withMappings = 0;
    for (let line = index + 1; line < end; line += 1) {
      if (!/^\s*with\s*:\s*(?:#.*)?$/.test(lines[line])) continue;
      const withIndent = indentation(lines[line]);
      if (withIndent !== stepIndent && withIndent !== stepIndent + 2) continue;
      withMappings += 1;
      for (let setting = line + 1; setting < end; setting += 1) {
        if (!lines[setting].trim() || /^\s*#/.test(lines[setting])) continue;
        const settingIndent = indentation(lines[setting]);
        if (settingIndent <= withIndent) break;
        if (settingIndent !== withIndent + 2) continue;
        const key = CREDENTIAL_SETTING.exec(lines[setting]);
        if (key) credentialSettings.push(key[1].trim());
      }
    }
    if (
      withMappings !== 1 ||
      credentialSettings.length !== 1 ||
      credentialSettings[0] !== 'false'
    ) {
      findings.push(`${location}: checkout requires exactly one with.persist-credentials: false`);
    }
  }
  return findings;
}

export function auditWorkflowDirectory(
  directory = join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows'),
) {
  const files = readdirSync(directory)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
  if (files.length === 0) throw new Error(`No GitHub Actions workflows in ${directory}`);
  const findings = files.flatMap((name) =>
    auditWorkflowText(readFileSync(join(directory, name), 'utf8'), name),
  );
  if (findings.length > 0) {
    throw new Error(`Workflow security check failed:\n${findings.join('\n')}`);
  }
  return files.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const count = auditWorkflowDirectory();
  console.log(`Verified immutable Actions and checkout token handling in ${count} workflow(s)`);
}
