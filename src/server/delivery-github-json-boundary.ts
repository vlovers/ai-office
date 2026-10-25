/**
 * Read untrusted GitHub JSON with a hard byte limit and a generic error.
 * Content-Length can be missing or forged; always count streamed bytes.
 * The caller must wrap this in withGitHubRequestDeadline for stalled bodies.
 */
export const GITHUB_JSON_LIMITS = {
  refs: 256 * 1024,
  detail: 1024 * 1024,
  listing: 8 * 1024 * 1024,
  draft: 1024 * 1024,
} as const;

export async function readBoundedGitHubText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('Invalid GitHub JSON response limit.');
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    throw new Error('GitHub JSON response exceeded the safe size limit.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing GitHub JSON response body.');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let content = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        throw new Error('GitHub JSON response exceeded the safe size limit.');
      }
      content += decoder.decode(value, { stream: true });
    }
    content += decoder.decode();
  } catch (error) {
    // Do not wait for an untrusted stream's cancellation to settle.
    void reader.cancel().catch(() => undefined);
    if (
      error instanceof Error &&
      error.message === 'GitHub JSON response exceeded the safe size limit.'
    ) {
      throw error;
    }
    throw new Error('Invalid GitHub JSON response body.');
  }
  return content;
}

/** Parse only after the complete UTF-8 body has passed the byte boundary. */
export async function readBoundedGitHubJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const content = await readBoundedGitHubText(response, maxBytes);
  try {
    return JSON.parse(content) as unknown;
  } catch {
    // Native JSON errors may echo remote contents, including secret strings.
    throw new Error('Invalid GitHub JSON response body.');
  }
}
