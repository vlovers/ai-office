import { expect, it } from 'vitest';
import { diagnoseWorkflow } from '../src/server/workflow-diagnostics.js';
import type { Workflow } from '../src/server/workflows.js';

const fixture = (
  state: Workflow['state'],
  stageState: Workflow['stages'][number]['state'],
): Workflow => ({
  id: 'workflow',
  repositoryId: 'repository',
  workspaceId: null,
  baselineRevision: 'abc',
  version: 3,
  state,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  stages: [
    {
      kind: 'coder',
      agentId: 'codex-1',
      agentRevision: 1,
      mode: 'write',
      state: stageState,
      taskId: null,
      approvedRevision: null,
      outputRevision: null,
      approvedAt: null,
    },
  ],
});

it('reports approval checkpoints without authorizing execution', () => {
  const result = diagnoseWorkflow(fixture('active', 'awaiting_approval'));
  expect(result.findings).toMatchObject([
    {
      code: 'approval-required',
      severity: 'attention',
      stage: 'coder',
      suggestedAction: 'approve-initial',
    },
  ]);
  expect(result.warning).toContain('do not prove process liveness');
});

it('reports interrupted execution without proposing automatic retries', () => {
  const result = diagnoseWorkflow(fixture('active', 'interrupted'));
  expect(result.findings[0]).toMatchObject({
    code: 'execution-interrupted',
    severity: 'blocked',
    suggestedAction: null,
  });
});

it('reports blocked workflows even when no stage carries a blocked flag', () => {
  const result = diagnoseWorkflow(fixture('blocked', 'completed'));
  expect(result.findings).toMatchObject([{ code: 'workflow-blocked' }]);
});

it('marks terminal workflows without implying they can be restarted', () => {
  const result = diagnoseWorkflow(fixture('completed', 'completed'));
  expect(result.findings).toMatchObject([{ code: 'terminal-workflow', severity: 'info' }]);
});
