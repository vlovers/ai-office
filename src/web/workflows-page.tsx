import { WorkflowBoard } from './workflow-board.js';

export function WorkflowsPage({ inspection }: { inspection?: { id: string; request: number } }) {
  return (
    <section
      className="workflows-destination"
      id="workflows"
      tabIndex={-1}
      aria-label="Workflow management"
    >
      <div className="destination-intro">
        <h2>Workflow runs</h2>
        <p>Inspect each stage, its handoffs, and any action waiting for approval.</p>
      </div>
      <WorkflowBoard inspection={inspection} />
    </section>
  );
}
