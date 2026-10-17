import { runVerification } from '../../src/server/verification.js';
const directory = process.argv[2]!;
await runVerification(
  [
    process.execPath,
    '-e',
    `const fs=require('node:fs');fs.writeFileSync('started.json',JSON.stringify({pid:process.pid,group:process.ppid}));setTimeout(()=>fs.writeFileSync('must-not-run','orphan wrote after backend exit'),10000);`,
  ],
  directory,
  60_000,
);
