/**
 * Accept the newest settled response without allowing slower, older requests
 * to overwrite newer dashboard or workflow snapshots.
 *
 * Requests may overlap (polling, SSE refreshes, explicit user actions).
 * A later request does not suppress an earlier response until it settles.
 */
export function createLatestResultGate() {
  let issued = 0;
  let settled = 0;

  return {
    begin(): number {
      issued += 1;
      return issued;
    },
    accept(ticket: number): boolean {
      if (ticket <= settled || ticket > issued || !Number.isSafeInteger(ticket)) return false;
      settled = ticket;
      return true;
    },
  };
}
