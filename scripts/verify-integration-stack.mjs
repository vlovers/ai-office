#!/usr/bin/env node
// Read-only Git integration ancestry attestation. Never fetches, checks out or mutates refs.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const REF = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,180}$/;

export function validateManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1)
    throw new Error('Expected version 1 manifest object');
  if (!SHA.test(value.baseSha ?? '')) throw new Error('baseSha must be full lowercase SHA');
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 64)
    throw new Error('Expected 1..64 steps');
  const seen = new Set();
  for (const step of value.steps) {
    if (
      !step ||
      typeof step !== 'object' ||
      Array.isArray(step) ||
      typeof step.name !== 'string' ||
      !REF.test(step.name) ||
      step.name.includes('..') ||
      step.name.includes('//') ||
      step.name.endsWith('/') ||
      step.name.endsWith('.lock') ||
      !SHA.test(step.sha ?? '') ||
      seen.has(step.name)
    )
      throw new Error('Invalid, unsafe or duplicate step');
    seen.add(step.name);
  }
  return value;
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_OPTIONAL_LOCKS: '0',
    },
  }).trim();
}

function isAncestor(repo, parent, child) {
  try {
    git(repo, ['merge-base', '--is-ancestor', parent, child]);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

export function verifyIntegrationStack(manifest, repo) {
  validateManifest(manifest);
  const failures = [];
  const top = git(repo, ['rev-parse', '--show-toplevel']);
  if (resolve(top) !== resolve(repo)) failures.push('Expected checkout root');
  if (git(repo, ['status', '--porcelain', '--untracked-files=normal']) !== '')
    failures.push('Checkout is dirty');
  const main = git(repo, ['rev-parse', '--verify', 'refs/heads/main^{commit}']);
  if (main !== manifest.baseSha)
    failures.push('Main moved: expected ' + manifest.baseSha + ', found ' + main);
  let parent = manifest.baseSha;
  const steps = [];
  for (const step of manifest.steps) {
    let actual;
    try {
      actual = git(repo, ['rev-parse', '--verify', 'refs/heads/' + step.name + '^{commit}']);
    } catch {
      failures.push('Missing local branch: ' + step.name);
      steps.push({ name: step.name, ok: false });
      continue;
    }
    const exact = actual === step.sha;
    const ancestor = isAncestor(repo, parent, actual);
    if (!exact) failures.push('Head changed: ' + step.name);
    if (!ancestor) failures.push('Not a descendant of prior step: ' + step.name);
    steps.push({ name: step.name, exact, ancestor, ok: exact && ancestor });
    parent = step.sha;
  }
  return { ok: failures.length === 0, baseSha: manifest.baseSha, steps, failures };
}

function main(args) {
  if (args.length !== 2)
    throw new Error(
      'Usage: node scripts/verify-integration-stack.mjs <manifest.json> <checkout-root>',
    );
  const result = verifyIntegrationStack(
    JSON.parse(readFileSync(resolve(args[0]), 'utf8')),
    resolve(args[1]),
  );
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write('Integration attestation failed: ' + error.message + '\n');
    process.exitCode = 2;
  }
}
