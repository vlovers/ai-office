import { WorkflowBoard } from './workflow-board.js';

export function WorkflowsPage({ inspection }: { inspection?: { id: string; request: number } }) {
  return (
    <section className="workflows-destination" aria-label="Workflow management">
      <div className="destination-intro">
        <h2>Workflow runs</h2>
        <p>Coder → Reviewer → QA. Review evidence and approve each gated handoff explicitly.</p>
        <ol className="workflow-stage-guide" aria-label="Workflow stages">
          <li>
            <strong>01 · Coder</strong>
            <span>Produce and capture evidence</span>
          </li>
          <li>
            <strong>02 · Reviewer</strong>
            <span>Inspect snapshot and report</span>
          </li>
          <li>
            <strong>03 · QA</strong>
            <span>Validate and approve result</span>
          </li>
        </ol>
      </div>
      <WorkflowBoard inspection={inspection} />
    </section>
  );
}
