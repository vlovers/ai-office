import {
  deliveryDataDirectory,
  deliverySessionStore,
  openDeliveryDatabase,
} from '../src/server/delivery-security-runtime.js';
import {
  deliveryIdentifierSchema,
  deliveryOperationSchema,
} from '../src/server/delivery-sessions.js';

/** OS-admin only. Secrets are displayed only by the explicit ticket command. */
async function main() {
  process.umask(0o077);
  const [command, operatorInput, workspaceInput, operationInput, ...extra] = process.argv.slice(2);
  if (extra.length || !command || !operatorInput) throw new Error('usage');
  const operatorId = deliveryIdentifierSchema.parse(operatorInput);
  const db = await openDeliveryDatabase(deliveryDataDirectory());
  try {
    const sessions = deliverySessionStore(db);
    if (['enable', 'disable', 'ticket'].includes(command) && !workspaceInput && !operationInput) {
      if (command === 'ticket') process.stdout.write(`${sessions.issueEnrollment(operatorId)}\n`);
      else sessions.setOperator(operatorId, command === 'enable');
    } else if (['grant', 'revoke-grant'].includes(command)) {
      sessions.setGrant(
        operatorId,
        deliveryIdentifierSchema.parse(workspaceInput),
        deliveryOperationSchema.parse(operationInput),
        command === 'grant',
      );
    } else throw new Error('usage');
  } finally {
    db.close();
  }
}
main().catch(() => {
  console.error(
    'Delivery admin failed. Use: enable|disable|ticket OPERATOR, or grant|revoke-grant OPERATOR WORKSPACE OPERATION.',
  );
  process.exitCode = 1;
});
