import {
  listAllGitHubPullRequests,
  type ReadOnlyGitHubOptions,
} from './delivery-github-readonly.js';
import {
  reconcileUncertainDraft,
  type DeliveryPublicationContext,
} from './delivery-publication-service.js';

/**
 * Server-only, read-only recovery path. The service acquires the shared Git
 * lease, revalidates the exact approved snapshot and checks the uncertain
 * journal entry before the GitHub GET requests are issued.
 *
 * A missing or malformed result leaves the durable journal uncertain.
 * This function never invokes GitHub POST/PATCH/PUT/DELETE.
 */
export function reconcileUncertainDraftViaGitHub(
  context: DeliveryPublicationContext,
  options: ReadOnlyGitHubOptions = {},
) {
  return reconcileUncertainDraft({
    ...context,
    listAllRemoteDrafts: (plan) => listAllGitHubPullRequests(plan, options),
  });
}
