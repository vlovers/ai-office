import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { AgentEvent, Session, Task } from '../shared/types.js';
import { countEventsAfter, isNearLogEnd, unreadBaseline } from './log-follow.js';

type FollowMode = 'following' | 'reading' | 'paused';

/** Retain only the selected task's reading position across workspace routes. */
export interface TaskLogView {
  taskId: string;
  mode: FollowMode;
  pausedAtId: number | null;
  scrollTop: number;
}

/**
 * Key this component by task ID. A task switch must never inherit another
 * task's paused cursor or scroll position, even before effects have run.
 */
function TaskEventLog({
  events,
  taskId,
  logView,
}: {
  events: AgentEvent[];
  taskId: string;
  logView?: RefObject<TaskLogView | undefined>;
}) {
  const logRef = useRef<HTMLDivElement>(null);
  const saved = logView?.current?.taskId === taskId ? logView.current : undefined;
  const [mode, setMode] = useState<FollowMode>(saved?.mode ?? 'following');
  const [pausedAtId, setPausedAtId] = useState<number | null>(saved?.pausedAtId ?? null);
  const latestEventId = events.at(-1)?.id;
  const unread = countEventsAfter(events, pausedAtId);
  const following = mode === 'following';

  useLayoutEffect(() => {
    if (logRef.current && saved) logRef.current.scrollTop = saved.scrollTop;
  }, []);

  // Scroll before paint so a new SSE event cannot briefly displace the reader
  // or produce an intermediate scroll event that disables follow mode.
  useLayoutEffect(() => {
    const log = logRef.current;
    if (log && following) log.scrollTop = log.scrollHeight;
    if (log && logView) logView.current = { taskId, mode, pausedAtId, scrollTop: log.scrollTop };
  }, [following, latestEventId, mode, pausedAtId, logView, taskId]);

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
                setPausedAtId((previous) => unreadBaseline(previous, latestEventId));
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
          if (logView?.current?.taskId === taskId)
            logView.current.scrollTop = event.currentTarget.scrollTop;
          // An explicit pause stays paused until the reader resumes it.
          // Reading mode, by contrast, resumes when the reader scrolls down.
          if (mode === 'paused') return;
          const log = event.currentTarget;
          if (isNearLogEnd(log.scrollTop, log.scrollHeight, log.clientHeight)) {
            setMode('following');
            setPausedAtId(null);
          } else {
            if (mode === 'following')
              setPausedAtId((previous) => unreadBaseline(previous, latestEventId));
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
  logView,
}: {
  task: Task;
  session?: Session;
  events: AgentEvent[];
  logView?: RefObject<TaskLogView | undefined>;
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
      <TaskEventLog key={task.id} events={events} taskId={task.id} logView={logView} />
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
