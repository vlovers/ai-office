import { useLayoutEffect, useRef, useState } from 'react';
import type { AgentEvent, Session, Task } from '../shared/types.js';
import { countEventsAfter, isNearLogEnd } from './log-follow.js';

type FollowMode = 'following' | 'reading' | 'paused';

/**
 * Key this component by task ID. A task switch must never inherit another
 * task's paused cursor or scroll position, even before effects have run.
 */
function TaskEventLog({ events }: { events: AgentEvent[] }) {
  const logRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<FollowMode>('following');
  const [pausedAtId, setPausedAtId] = useState<number | null>(null);
  const latestEventId = events.at(-1)?.id;
  const unread = countEventsAfter(events, pausedAtId);
  const following = mode === 'following';

  // Scroll before paint so a new SSE event cannot briefly displace the reader
  // or produce an intermediate scroll event that disables follow mode.
  useLayoutEffect(() => {
    const log = logRef.current;
    if (log && following) log.scrollTop = log.scrollHeight;
  }, [following, latestEventId]);

  return (
    <>
      {events.length > 0 && (
        <div className="event-console-toolbar">
          <span>
            {events.length} recent events
            {!following && unread > 0 ? ` · ${unread} new` : ''}
          </span>
          {following ? (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setPausedAtId(latestEventId ?? 0);
                setMode('paused');
              }}
            >
              Pause auto-scroll
            </button>
          ) : (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setPausedAtId(null);
                setMode('following');
              }}
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
        aria-live={following ? 'polite' : 'off'}
        tabIndex={0}
        onScroll={(event) => {
          // An explicit pause stays paused until the reader resumes it.
          // Reading mode, by contrast, resumes when the reader scrolls down.
          if (mode === 'paused') return;
          const log = event.currentTarget;
          if (isNearLogEnd(log.scrollTop, log.scrollHeight, log.clientHeight)) {
            setMode('following');
            setPausedAtId(null);
          } else {
            if (mode === 'following') setPausedAtId(latestEventId ?? 0);
            setMode('reading');
          }
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
    </>
  );
}

export function TaskSessionOutput({
  task,
  session,
  events,
}: {
  task: Task;
  session?: Session;
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
      <TaskEventLog key={task.id} events={events} />
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
