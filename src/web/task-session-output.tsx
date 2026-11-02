import { useEffect, useRef, useState } from 'react';
import type { AgentEvent, Session, Task } from '../shared/types.js';
import { isNearLogEnd } from './log-follow.js';

export function TaskSessionOutput({
  task,
  session,
  events,
}: {
  task: Task;
  session?: Session;
  events: AgentEvent[];
}) {
  const logRef = useRef<HTMLDivElement>(null);
  const [followLatest, setFollowLatest] = useState(true);
  const latestEventId = events.at(-1)?.id;

  // Switching tasks starts a new reading context. Do not carry a previous
  // task's paused scroll position into this task's live event log.
  useEffect(() => {
    setFollowLatest(true);
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [task.id]);

  useEffect(() => {
    const log = logRef.current;
    if (log && followLatest) log.scrollTop = log.scrollHeight;
  }, [followLatest, latestEventId, task.id]);

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
      {events.length > 0 && (
        <div className="event-console-toolbar">
          <span>{events.length} recent events</span>
          {!followLatest && (
            <button
              type="button"
              className="secondary"
              onClick={() => setFollowLatest(true)}
            >
              Jump to latest event
            </button>
          )}
        </div>
      )}
      <div
        ref={logRef}
        className="event-console"
        aria-label="Agent event log"
        role="log"
        tabIndex={0}
        onScroll={(event) => {
          const log = event.currentTarget;
          setFollowLatest(
            isNearLogEnd(log.scrollTop, log.scrollHeight, log.clientHeight),
          );
        }}
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
