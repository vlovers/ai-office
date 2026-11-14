/** Decode workflow API responses without hiding HTTP failures behind JSON parse errors. */
export async function readWorkflowResponse<T>(response: Response): Promise<T> {
  const body = await response.text();
  let value: unknown;
  try {
    value = body ? JSON.parse(body) : undefined;
  } catch {
    if (response.ok) throw new Error(`Invalid workflow response: HTTP ${response.status}`);
    throw new Error(`Workflow request failed: HTTP ${response.status}`);
  }

  if (!response.ok) {
    const message =
      value !== null &&
      typeof value === 'object' &&
      'error' in value &&
      typeof value.error === 'string' &&
      value.error.trim()
        ? value.error
        : `Workflow request failed: HTTP ${response.status}`;
    throw new Error(message);
  }
  if (value === undefined) {
    throw new Error(`Empty workflow response: HTTP ${response.status}`);
  }
  // Workflow endpoints return JSON objects or arrays. A valid JSON scalar
  // (including null) is not a valid checkpoint and must fail closed rather
  // than reaching UI code as a trusted typed response.
  if (value === null || typeof value !== 'object') {
    throw new Error(`Invalid workflow response: HTTP ${response.status}`);
  }
  return value as T;
}
