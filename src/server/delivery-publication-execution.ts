import type { DeliveryJournal } from './delivery-journal.js';
import type { PublicationReadiness } from './delivery-publication-coordinator.js';

/**
 * The caller must hold the shared repository lease and revalidate the plan
 * before invoking this boundary. It never retries an ambiguous remote write.
 */
export async function executeReservedPublication(
  journal: DeliveryJournal,
  workspaceId: string,
  readiness: PublicationReadiness,
  publish: () => Promise<string>,
) {
  if (readiness.status !== 'requires-lease') {
    throw new Error('Publication is blocked or already completed.');
  }
  const key = readiness.operationKey;
  // Durable reservation must happen before any external side effect.
  journal.reserve(workspaceId, key);
  let url: string;
  try {
    url = await publish();
  } catch (error) {
    journal.markUncertain(workspaceId, key);
    throw error;
  }
  try {
    return journal.publish(workspaceId, key, url);
  } catch (error) {
    // The remote operation may have succeeded. Never attempt it again blindly.
    journal.markUncertain(workspaceId, key);
    throw error;
  }
}
