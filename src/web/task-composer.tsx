import type { AgentId, Dashboard } from '../shared/types.js';

type AssignableAgent = { id: AgentId; name: string; state: string };
export type CreateTaskInput = { title: string; prompt: string; executionMode: string };

export function TaskComposer({
  dashboard, selectedAgent, repositoryId, executionMode, selectedProfile,
  assignable, canAssign, agentName, busy, onAgentChange, onRepositoryChange,
  onExecutionModeChange, onCreateTask,
}: {
  dashboard?: Dashboard;
  selectedAgent: AgentId;
  repositoryId: string;
  executionMode: string;
  selectedProfile?: { maximumMode: string };
  assignable: AssignableAgent[];
  canAssign: boolean;
  agentName?: string;
  busy: boolean;
  onAgentChange: (id: AgentId) => void;
  onRepositoryChange: (id: string) => void;
  onExecutionModeChange: (mode: string) => void;
  onCreateTask: (input: CreateTaskInput, form: HTMLFormElement) => void;
}) {
  return (
    <section className="panel compose" id="compose" tabIndex={-1} data-task-panel="new">
                <div className="panel-heading">
                  <h2>Create a task</h2>
                  <span className="step">02</span>
                </div>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = event.currentTarget;
                    const data = new FormData(form);
                    onCreateTask({
                      title: String(data.get('title') ?? ''),
                      prompt: String(data.get('prompt') ?? ''),
                      executionMode: String(data.get('executionMode') ?? 'read-only'),
                    }, form);
                  }}
                >
                  <label htmlFor="assigned-agent">Assign to agent</label>
                  <select
                    id="assigned-agent"
                    value={selectedAgent}
                    onChange={(event) => {
                      onAgentChange(event.target.value);
                    }}
                  >
                    {!canAssign && (
                      <option value={selectedAgent} disabled>
                        Select an active profile
                      </option>
                    )}
                    {assignable.map((slot) => (
                      <option key={slot.id} value={slot.id}>
                        {slot.name} · {slot.id.slice(0, 8)} · {slot.state}
                      </option>
                    ))}
                  </select>
                  <label htmlFor="repository">Repository</label>
                  <select
                    id="repository"
                    required
                    value={repositoryId}
                    onChange={(event) => {
                      onRepositoryChange(event.target.value);
                    }}
                  >
                    <option value="" disabled>
                      Select a repository
                    </option>
                    {dashboard?.repositories.map((repo) => (
                      <option key={repo.id} value={repo.id}>
                        {repo.name}
                      </option>
                    ))}
                  </select>
                  <label htmlFor="executionMode">Execution mode</label>
                  <select
                    id="executionMode"
                    name="executionMode"
                    value={executionMode}
                    onChange={(event) => onExecutionModeChange(event.target.value)}
                  >
                    <option value="read-only">Read-only review</option>
                    <option value="write" disabled={selectedProfile?.maximumMode !== 'write'}>
                      Isolated coding · write enabled
                    </option>
                  </select>
                  <label htmlFor="title">Task title</label>
                  <input
                    id="title"
                    name="title"
                    required
                    maxLength={160}
                    placeholder="Review the project structure"
                  />
                  <label htmlFor="prompt">What should the agent work on?</label>
                  <textarea
                    id="prompt"
                    name="prompt"
                    required
                    maxLength={16000}
                    rows={5}
                    placeholder="Explore the codebase, explain how it fits together, and suggest the next improvement…"
                  />
                  <div className="compose-footer">
                    <span>
                      <span className="tiny-avatar">⌘</span> Assigned to{' '}
                      {agentName ?? 'Select a profile'}
                    </span>
                    <button disabled={busy || !repositoryId || !canAssign}>
                      Create task <span>→</span>
                    </button>
                  </div>
                </form>
                <p className="read-only-note">
                  Start submits to the assigned FIFO queue and may execute immediately. Isolated
                  coding requires confirmation and server-configured roots. Review changes before
                  keeping or rejecting; integration is manual.
                </p>
              </section>
  );
}
