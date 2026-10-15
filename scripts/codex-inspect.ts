/** Metadata only. No inference, credential-file access, or token requests. */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MetadataClient, localCli } from '../src/server/providers/codex-metadata.js';
export { MetadataClient, localCli };
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { executable, env } = localCli();
  const client = new MetadataClient(executable, env, '/private/tmp');
  try {
    await client.initialize();
    console.log(
      JSON.stringify(
        {
          cliVersion: execFileSync(executable, ['--version'], {
            env,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          }).trim(),
          authentication: await client.account(),
          models: await client.models(),
          apiKeyEnvironmentForwarded: false,
          credentialFilesOpenedByApplication: false,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.log(error instanceof Error ? error.message : 'Metadata inspection failed.');
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}
