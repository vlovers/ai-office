import { describe, expect, it } from 'vitest';
import { readWorkflowResponse } from '../src/web/workflow-http.js';

describe('workflow API response handling', () => {
  it('returns a successful JSON response without changing its shape', async () => {
    const response = new Response(JSON.stringify({ workflows: [{ id: 'one' }] }), {
      status: 200,
    });
    await expect(readWorkflowResponse(response)).resolves.toEqual({
      workflows: [{ id: 'one' }],
    });
  });

  it('preserves a structured server error', async () => {
    const response = new Response(JSON.stringify({ error: 'Checkpoint version conflict' }), {
      status: 409,
    });
    await expect(readWorkflowResponse(response)).rejects.toThrow('Checkpoint version conflict');
  });

  it('reports HTTP status for proxy HTML instead of a JSON parsing exception', async () => {
    const response = new Response('<html>Bad gateway</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    });
    await expect(readWorkflowResponse(response)).rejects.toThrow(
      'Workflow request failed: HTTP 502',
    );
  });

  it('rejects missing or invalid server error fields without exposing raw bodies', async () => {
    const response = new Response(JSON.stringify({ error: { debug: 'internal' } }), {
      status: 503,
    });
    await expect(readWorkflowResponse(response)).rejects.toThrow(
      'Workflow request failed: HTTP 503',
    );
  });

  it('reports malformed successful responses as invalid API data', async () => {
    const response = new Response('not json', { status: 200 });
    await expect(readWorkflowResponse(response)).rejects.toThrow(
      'Invalid workflow response: HTTP 200',
    );
  });

  it('rejects empty success bodies instead of treating them as valid checkpoints', async () => {
    const response = new Response(null, { status: 204 });
    await expect(readWorkflowResponse(response)).rejects.toThrow(
      'Empty workflow response: HTTP 204',
    );
  });

  it('reports an empty error body with its HTTP status', async () => {
    const response = new Response(null, { status: 504 });
    await expect(readWorkflowResponse(response)).rejects.toThrow(
      'Workflow request failed: HTTP 504',
    );
  });
});
