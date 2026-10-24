import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const SHA_ACTION = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[a-f0-9]{40}$/;
const SHA_DOCKER = /^docker:\/\/[^\s@]+@sha256:[a-f0-9]{64}$/;

function indentation(line) {
  return /^\s*/.exec(line)[0].length;
}

export function auditWorkflowText(source, filename = 'workflow') {
  const findings = [];
  const lines = source.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*(?:-\s*)?uses:\s*([^\s#]+)/.exec(lines[index]);
    if (!match) continue;

    const reference = match[1];
    const location = `${filename}:${index + 1}`;
    if (!reference.startsWith('./') && !SHA_ACTION.test(reference) && !SHA_DOCKER.test(reference)) {
      findings.push(
        `${location}: external action must use an immutable commit SHA or Docker digest (${reference})`,
      );
    }

    if (!reference.startsWith('actions/checkout@')) continue;

    const stepIndent = indentation(lines[index]);
    let end = index + 1;
    while (
      end < lines.length &&
      (!lines[end].trim() ||
        indentation(lines[end]) > stepIndent ||
        (indentation(lines[end]) === stepIndent && !/^\s*-\s/.test(lines[end])))
    ) {
      end += 1;
    }

    const withIndex = lines.findIndex(
      (line, offset) =>
        offset > index &&
        offset < end &&
        (indentation(line) === stepIndent || indentation(line) === stepIndent + 2) &&
        /^\s*with:\s*(?:#.*)?$/.test(line),
    );
    let safe = false;
    if (withIndex !== -1) {
      const withIndent = indentation(lines[withIndex]);
      for (let line = withIndex + 1; line < end; line += 1) {
        if (lines[line].trim() && indentation(lines[line]) <= withIndent) break;
        if (
          /^\s*persist-credentials:\s*false\s*(?:#.*)?$/.test(lines[line]) &&
          indentation(lines[line]) === withIndent + 2
        )
          safe = true;
      }
    }
    if (!safe) findings.push(`${location}: checkout requires with.persist-credentials: false`);
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
