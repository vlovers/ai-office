import { join } from 'node:path';
import { acquireLock } from './lock.js';
import { DeliveryGitHubCredentials } from './delivery-github-credentials.js';
import { createDeliverySecurityApp } from './delivery-security-app.js';
import { DeliverySecurityService } from './delivery-security-service.js';
import { DeliverySecurityError } from './delivery-sessions.js';
import {
  deliveryDataDirectory,
  deliverySessionStore,
  openDeliveryDatabase,
  readDeliverySecurityConfig,
  recoverDeliverySecurityRuntime,
} from './delivery-security-runtime.js';

async function main() {
  process.umask(0o077);
  const directory = deliveryDataDirectory();
  const config = await readDeliverySecurityConfig(
    process.env.AI_OFFICE_DELIVERY_CONFIG ?? join(directory, 'config.json'),
  );
  const db = await openDeliveryDatabase(directory);
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireLock(join(directory, 'server.lock'), 'AI Office Delivery API');
    const credentials = process.env.AI_OFFICE_DELIVERY_GITHUB_TOKEN
      ? new DeliveryGitHubCredentials(db, async () => ({
          id: process.env.AI_OFFICE_DELIVERY_GITHUB_CREDENTIAL_ID ?? '',
          token: process.env.AI_OFFICE_DELIVERY_GITHUB_TOKEN ?? '',
          repository: process.env.AI_OFFICE_DELIVERY_GITHUB_REPOSITORY ?? '',
          expiresAt: Number(process.env.AI_OFFICE_DELIVERY_GITHUB_EXPIRES_AT),
          permissions: { contents: 'read', pullRequests: 'read' },
        }))
      : undefined;
    const service = new DeliverySecurityService(
      deliverySessionStore(db),
      config.workspaces,
      credentials,
    );
    await recoverDeliverySecurityRuntime(service, config);
    const app = createDeliverySecurityApp(service, config.publicOrigin);
    const port = Number(process.env.AI_OFFICE_DELIVERY_PORT ?? '4311');
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new DeliverySecurityError(503);
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      await app.close();
      db.close();
      await release?.();
    };
    process.once('SIGTERM', () => {
      void shutdown();
    });
    process.once('SIGINT', () => {
      void shutdown();
    });
    await app.listen({ host: '127.0.0.1', port });
    const address = app.server.address();
    console.log(
      `Delivery API listening on loopback port ${address && typeof address !== 'string' ? address.port : port}; remote writes disabled.`,
    );
  } catch {
    db.close();
    await release?.();
    throw new DeliverySecurityError(503);
  }
}

main().catch(() => {
  console.error('Delivery API startup failed. Inspect trusted configuration, database and leases.');
  process.exitCode = 1;
});
