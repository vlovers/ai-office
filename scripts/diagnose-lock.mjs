#!/usr/bin/env node
// Read-only diagnostics. Never remove, rename or steal an AI Office lease.
import { readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = resolve(process.cwd(), '.ai-office');
const directory = join(root, 'server.lock');
const ownerFile = join(directory, 'owner.json');

try {
  await stat(directory);
} catch (error) {
  if (error?.code === 'ENOENT') {
    console.log('No AI Office server lease exists in', directory);
    process.exit(0);
  }
  throw error;
}

console.log('AI Office lease:', directory);
let owner;
try {
  owner = JSON.parse(await readFile(ownerFile, 'utf8'));
} catch {
  console.error(
    'Owner metadata is missing or invalid. Treat this lease as occupied until manually investigated.',
  );
  process.exitCode = 2;
}

if (owner) {
  console.log('Owner PID:', owner.pid);
  console.log('Lease purpose:', owner.detail);
  console.log('Created:', owner.at);
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
    console.error('Invalid PID. Do not modify this lease without manual inspection.');
    process.exitCode = 2;
  } else {
    try {
      process.kill(owner.pid, 0);
      console.warn(
        'A process currently has this PID. It may not be the original owner: inspect it with ps before acting.',
      );
      process.exitCode = 2;
    } catch (error) {
      if (error?.code === 'ESRCH') {
        console.log(
          'The recorded PID is not running. Verify no other AI Office instance is active before archiving the lease.',
        );
      } else {
        console.warn('Cannot verify the process owner:', error?.code ?? 'unknown error');
        process.exitCode = 2;
      }
    }
  }
}
