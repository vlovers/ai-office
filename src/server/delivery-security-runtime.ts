import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { DeliveryJournal } from './delivery-journal.js';
import { publicationKey } from './delivery-publication-idempotency.js';
import { recoverRegisteredDeliveryWorkspaces } from './delivery-startup-coordinator.js';
import { deliveryWorkspaceSchema, DeliverySecurityService } from './delivery-security-service.js';
import { DeliverySessions, DeliverySecurityError } from './delivery-sessions.js';

export const deliverySecurityConfigSchema = z
  .object({
    publicOrigin: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return url.protocol === 'https:' && url.origin === value;
      }),
    workspaces: z.array(deliveryWorkspaceSchema).max(1000),
  })
  .strict();

export async function readDeliverySecurityConfig(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > 1024 * 1024 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new DeliverySecurityError(503);
    return deliverySecurityConfigSchema.parse(JSON.parse(await file.readFile('utf8')));
  } finally {
    await file.close();
  }
}

export async function openDeliveryDatabase(directory: string) {
  const path = resolve(directory);
  await mkdir(path, { recursive: true, mode: 0o700 });
  // Never silently repair an unexpected directory or an existing database.
  // A misconfigured path must not chmod or open another application's files.
  if ((await realpath(path)) !== path) throw new DeliverySecurityError(503);
  const directoryInfo = await lstat(path);
  if (
    !directoryInfo.isDirectory() ||
    (directoryInfo.mode & 0o077) !== 0 ||
    (process.getuid && directoryInfo.uid !== process.getuid())
  )
    throw new DeliverySecurityError(503);

  const databasePath = join(path, 'delivery.sqlite');
  // SQLite may open existing rollback-journal, WAL and shared-memory files by pathname.
  // Refuse unsafe companions before handing the database to SQLite.
  for (const suffix of ['-journal', '-wal', '-shm']) {
    let info;
    try {
      info = await lstat(databasePath + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new DeliverySecurityError(503);
  }
  const file = await open(
    databasePath,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const info = await file.stat();
    // In particular, reject a pre-existing hard link: chmod/opening it could
    // affect unrelated data despite O_NOFOLLOW rejecting symbolic links.
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new DeliverySecurityError(503);
  } finally {
    await file.close();
  }

  const db = new DatabaseSync(databasePath);
  try {
    db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000; PRAGMA synchronous=FULL;',
    );
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Run before listen; the caller must hold the dedicated metadata startup lock. */
export async function recoverDeliverySecurityRuntime(
  service: DeliverySecurityService,
  config: z.infer<typeof deliverySecurityConfigSchema>,
) {
  return recoverRegisteredDeliveryWorkspaces({
    journal: new DeliveryJournal(service.sessions.db),
    transferJournal: service.journal,
    registrations: config.workspaces.map((workspace) => ({
      workspaceId: workspace.workspaceId,
      operationKey: publicationKey(workspace.plan),
      repository: workspace.repository,
      worktree: workspace.worktree,
      transferIdentity: {
        workspaceId: workspace.workspaceId,
        operationKey: publicationKey(workspace.plan),
        destination: workspace.plan.destination,
        branch: workspace.plan.branch,
        headSha: workspace.headSha,
        baseSha: workspace.baseSha,
      },
    })),
  });
}

export function deliveryDataDirectory() {
  return resolve(process.env.AI_OFFICE_DELIVERY_DATA_DIR ?? '.ai-office/delivery');
}

export function deliverySessionStore(db: DatabaseSync) {
  return new DeliverySessions(db);
}
