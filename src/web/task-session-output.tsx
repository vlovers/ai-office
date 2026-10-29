import type { AgentEvent, Task } from '../shared/types.js';

export function TaskSessionOutput({
  task,
  session,
  events,
}: {
  task: Task;
  session?: { threadId?: string | null; authMode?: string; model?: string };
  events: AgentEvent[];
}) {
  return (
    <>
                    <p className="task-prompt">{task.prompt}</p>
                    {session?.threadId && (
                      <p className="thread-id">
                        Thread <code>{session.threadId}</code>
                        <span className="session-mode">
                          {session.authMode === 'local-cli-chatgpt'
                            ? 'ChatGPT login'
                            : session.authMode === 'api-key'
                              ? 'API key'
                              : 'Legacy session'}
                          {session.model ? ` · ${session.model}` : ''}
                        </span>
                      </p>
                    )}
                    <div
                      className="event-console"
                      aria-label="Agent event log"
                      role="log"
                      tabIndex={0}
                    >
                      {events.length ? (
                        events.map((item) => (
                          <div className="event-line" key={item.id}>
                            <time>{new Date(item.at).toLocaleTimeString()}</time>
                            <span className="event-kind">{item.kind}</span>
                            <pre>{item.message}</pre>
                          </div>
                        ))
                      ) : (
                        <span className="console-placeholder">
                          Ready. Start this task to open a Codex session.
                        </span>
                      )}
                    </div>
                    {task.error && (
                      <p className="task-error" role="alert">
                        {task.error}
                      </p>
                    )}
                    {task.result && (
                      <div className="result">
                        <h3>Final result</h3>
                        <pre>{task.result}</pre>
                      </div>
                    )}

    </>
  );
}
