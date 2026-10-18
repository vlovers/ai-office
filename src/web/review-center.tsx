import React, { useEffect, useRef, useState } from 'react';
import type {
  Task,
  WorkspaceReview,
  ReviewRecord,
  ReviewComment,
  ReviewHistoryEntry,
} from '../shared/types.js';
import { diffLines } from '../shared/diff.js';

type Api = <T>(path: string, body?: unknown) => Promise<T>;
const changeType = (status: string) =>
  status.includes('D')
    ? 'Deleted'
    : status.includes('R')
      ? 'Renamed'
      : status === '??' || status.includes('A')
        ? 'Added'
        : 'Modified';
function Code({ text, path }: { text: string; path: string }) {
  // Small text tokenizer, never HTML. Only common source extensions receive keywords.
  if (!/\.(tsx?|jsx?|py|rs|go|java|c|cpp|css|json)$/.test(path)) return <>{text}</>;
  return (
    <>
      {text
        .split(
          /(\b(?:const|let|function|return|import|export|class|if|else|def|fn|pub|true|false|null|async|await|type|interface)\b)/g,
        )
        .map((part, i) =>
          i % 2 ? (
            <span className="diff-keyword" key={i}>
              {part}
            </span>
          ) : (
            part
          ),
        )}
    </>
  );
}
export function ReviewCenter({ task, api }: { task: Task; api: Api }) {
  const [review, setReview] = useState<WorkspaceReview>();
  const [history, setHistory] = useState<ReviewHistoryEntry[]>([]);
  const [historical, setHistorical] = useState('');
  const [selected, setSelected] = useState('');
  const [filter, setFilter] = useState('');
  const [type, setType] = useState('All');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [dirty, setDirty] = useState(false);
  const [body, setBody] = useState('');
  const [editId, setEditId] = useState('');
  const [scope, setScope] = useState('general');
  const [anchor, setAnchor] = useState<ReviewComment['anchor']>();
  const [offset, setOffset] = useState(0);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const requestButton = useRef<HTMLButtonElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const diff = useRef<HTMLDivElement>(null);
  const record = historical ? history.find((item) => item.revision === historical) : review?.record;
  const files = historical ? (record?.files ?? []) : (review?.files ?? []);
  const visibleFiles = files.filter(
    (file) =>
      file.path.toLowerCase().includes(filter.toLowerCase()) &&
      (type === 'All' || type === changeType(file.status)),
  );
  const groups = new Map<string, typeof files>();
  for (const item of visibleFiles) {
    const directory = item.path.includes('/')
      ? item.path.slice(0, item.path.lastIndexOf('/'))
      : '(root)';
    groups.set(directory, [...(groups.get(directory) ?? []), item]);
  }
  const file = visibleFiles.find((file) => file.path === selected) ?? visibleFiles[0];
  const lines = diffLines(file?.patch ?? '');
  const pending = review?.workspace.decision === 'pending' && !review.workspace.recoveryError;
  const unsaved = dirty || !!body.trim();
  const editable = !historical && pending && !!record && !record.submittedAt;
  const submitted = history.find((item) => item.revision === record?.revision);
  const activeIteration = history.find((item) =>
    ['queued', 'running', 'stopping'].includes(item.continuation?.state ?? ''),
  );
  const running = !!activeIteration || ['running', 'stopping'].includes(task.state);
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);
  async function refresh(discard = false) {
    const entries = await api<ReviewHistoryEntry[]>(`/tasks/${task.id}/review/history`);
    setHistory(entries);
    if (
      !['running', 'stopping'].includes(task.state) &&
      !entries.some((item) =>
        ['queued', 'running', 'stopping'].includes(item.continuation?.state ?? ''),
      )
    ) {
      const fresh = await api<WorkspaceReview>(`/tasks/${task.id}/review`);
      setReview(fresh);
      if (discard || (!unsaved && !historical)) setComments(fresh.record?.comments ?? []);
      if (discard) {
        setBody('');
        setEditId('');
        setDirty(false);
      }
      setHistory(await api<ReviewHistoryEntry[]>(`/tasks/${task.id}/review/history`));
    }
  }
  useEffect(() => {
    void execute(refresh);
  }, [task.id, task.state]);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      void refresh().catch((e) => setError(e.message));
    }, 1500);
    return () => clearInterval(timer);
  }, [running, task.id, task.state]);
  useEffect(() => {
    setComments(record?.comments ?? []);
    setDirty(false);
    setBody('');
    setEditId('');
    setAnchor(undefined);
    setOffset(0);
  }, [record?.revision, historical]);
  useEffect(() => {
    setOffset(0);
    if (!editId) {
      setAnchor(undefined);
      setScope('general');
    }
  }, [file?.path]);
  async function execute(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function decision(action: 'keep' | 'reject' | 'verify', command?: string) {
    const message =
      action === 'reject'
        ? 'Permanently discard ALL uncommitted and untracked files in this task worktree? The branch is preserved. This cannot be undone.'
        : action === 'keep'
          ? 'Keep these changes in the isolated worktree and branch? Integration remains manual.'
          : `Run on host: ${JSON.stringify(review?.commandDetails?.[command ?? ''])}\n\nThis executes project code, including AI edits, with your full OS permissions and network access. It can read credentials or modify other checkouts. Inspect the scripts first. Continue?`;
    if (!window.confirm(message)) return;
    await execute(async () => {
      await api(`/tasks/${task.id}/review`, {
        action,
        command,
        confirmed: true,
        revision: review?.revision,
        confirmedHostExecution: action === 'verify',
      });
      await refresh();
    });
  }
  function addComment() {
    if (!body.trim()) return;
    const now = new Date().toISOString();
    const previous = comments.find((item) => item.id === editId);
    const comment: ReviewComment = {
      id: editId || crypto.randomUUID(),
      body: body.trim(),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      ...(scope !== 'general' && file ? { path: file.path, ...(anchor ? { anchor } : {}) } : {}),
    };
    setComments([...comments.filter((item) => item.id !== editId), comment]);
    setDirty(true);
    setBody('');
    setEditId('');
    setAnchor(undefined);
  }
  async function save() {
    await execute(async () => {
      const saved = await api<ReviewRecord>(`/tasks/${task.id}/review/feedback`, {
        revision: record?.revision,
        version: record?.version,
        comments,
      });
      setReview((current) => (current ? { ...current, record: saved } : current));
      setComments(saved.comments);
      setDirty(false);
      await refresh();
    });
  }
  function closeDialog() {
    dialog.current?.close();
    requestButton.current?.focus();
  }
  function focusHunk(direction: number) {
    const hunks = lines
      .map((line, index) => (line.kind === 'hunk' ? index : -1))
      .filter((index) => index >= 0);
    const next =
      direction > 0
        ? hunks.find((index) => index > offset)
        : hunks.filter((index) => index < offset).at(-1);
    if (next !== undefined) {
      setOffset(next);
      diff.current?.focus();
    }
  }
  return (
    <section
      className="file-summary review-center"
      id="code-review-center"
      tabIndex={-1}
      aria-label="Isolated changes review"
      aria-busy={busy}
    >
      <div className="review-heading">
        <div>
          <span className="eyebrow">CHANGE CONTROL</span>
          <h3>Code Review Center</h3>
        </div>
        <button
          className="secondary"
          disabled={busy || unsaved}
          onClick={() => void execute(refresh)}
        >
          Refresh Git review
        </button>
      </div>
      {busy && <p role="status">Loading review…</p>}
      {error && (
        <p role="alert">
          {error}{' '}
          <button
            className="secondary"
            disabled={busy || unsaved}
            onClick={() => void execute(refresh)}
          >
            Retry review
          </button>
        </p>
      )}
      {unsaved && (
        <button
          className="secondary"
          disabled={busy}
          onClick={() => {
            if (
              window.confirm(
                'Discard unsaved local review edits and reload? Saved feedback and history are retained.',
              )
            )
              void execute(() => refresh(true));
          }}
        >
          Discard unsaved edits and reload
        </button>
      )}
      {running && (
        <p role="status">
          Codex continuation: {activeIteration?.continuation?.state ?? task.state}. Waiting for
          worker cleanup and a fresh Git revision. Use the task controls to stop the continuation.
          {activeIteration?.continuation && (
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void execute(async () => {
                  await api(`/tasks/${activeIteration.continuation!.id}/stop`, {});
                  await refresh();
                })
              }
            >
              Stop continuation
            </button>
          )}
        </p>
      )}
      {submitted?.continuation?.error && (
        <p role="alert">
          Continuation {submitted.continuation.state}: {submitted.continuation.error} Inspect the
          saved session and worktree, then refresh review. No replacement session is started.
        </p>
      )}
      {review && (
        <>
          <p>
            Decision: <strong>{review.workspace.decision}</strong> · Review revision{' '}
            {record?.number ?? '—'}{' '}
            {historical ? '· HISTORICAL PATCH — not current filesystem' : '· Current Git review'}
          </p>
          <details>
            <summary>Workspace identity</summary>
            <p>
              Task {task.title} ({task.id})<br />
              Branch <code>{review.workspace.branch}</code>
              <br />
              Worktree <code>{review.workspace.path}</code>
              <br />
              Base <code>{review.workspace.base}</code>
            </p>
          </details>
          {review.workspace.recoveryError && <p role="alert">{review.workspace.recoveryError}</p>}
        </>
      )}
      <label>
        Review history
        <select
          value={historical}
          disabled={unsaved || busy}
          onChange={(e) => setHistorical(e.target.value)}
        >
          <option value="">Current Git review</option>
          {history.map((item) => (
            <option value={item.revision} key={item.revision}>
              Revision {item.number} · {item.submittedAt ? 'Changes requested' : 'Draft review'} ·{' '}
              {item.createdAt}
            </option>
          ))}
        </select>
      </label>
      <div className="review-diff-controls">
        <button
          className="secondary"
          disabled={busy || unsaved || running}
          onClick={() =>
            void execute(async () => {
              setHistorical('');
              await refresh();
            })
          }
        >
          Latest history
        </button>
        <button
          className="secondary"
          disabled={busy || unsaved || running || history.length < 20}
          onClick={() =>
            void execute(async () => {
              const older = await api<ReviewHistoryEntry[]>(
                `/tasks/${task.id}/review/history?before=${history.at(-1)?.number}`,
              );
              setHistorical('');
              setHistory(older);
            })
          }
        >
          Older history
        </button>
      </div>
      {!!history.length && (
        <details className="review-iterations">
          <summary>Iteration outcomes and verification</summary>
          <ol>
            {history.map((item) => (
              <li key={item.revision}>
                Revision {item.number} ·{' '}
                {item.submittedAt ? `Changes requested ${item.submittedAt}` : 'Draft'} ·{' '}
                {item.continuation?.state ?? 'No continuation'}
                {item.continuation?.error && (
                  <p role="alert">
                    {item.continuation.error} Inspect the saved native session and worktree, then
                    refresh and explicitly confirm new feedback to retry.
                  </p>
                )}
                <small>
                  Session {item.sessionId ?? 'Unavailable'} · Thread{' '}
                  {item.threadId ?? 'Unavailable'} · Verification{' '}
                  {item.verification ? (item.verification.passed ? 'passed' : 'failed') : 'not run'}
                  {item.verification && item.verification.revision !== item.revision
                    ? ' (earlier revision)'
                    : ''}
                </small>
              </li>
            ))}
          </ol>
        </details>
      )}
      {record && (
        <>
          <p className="review-meta">
            {files.length} changed files · {record.createdAt} ·{' '}
            {record.submittedAt ? `Changes requested ${record.submittedAt}` : 'Draft feedback'}
            <br />
            Session {record.sessionId ?? 'Unavailable'} · Thread {record.threadId ?? 'Unavailable'}
          </p>
          {historical && (
            <p role="note">
              Saved bounded patch only; no filesystem snapshot. Line anchors from this revision are
              outdated for all other revisions. Historical controls cannot execute changes.
            </p>
          )}
          <div className="review-workspace">
            <aside className="review-explorer" aria-label="Changed files">
              <label>
                Filter files
                <input
                  value={filter}
                  disabled={busy || !!body.trim()}
                  onChange={(e) => {
                    setFilter(e.target.value);
                    setOffset(0);
                  }}
                />
              </label>
              <label>
                Change type
                <select
                  value={type}
                  disabled={busy || !!body.trim()}
                  onChange={(e) => {
                    setType(e.target.value);
                    setOffset(0);
                  }}
                >
                  {['All', 'Added', 'Modified', 'Deleted', 'Renamed'].map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </label>
              <p>
                {visibleFiles.length} of {files.length} files
              </p>
              <div
                className="review-file-list"
                role="group"
                aria-label="File selection"
                onKeyDown={(e) => {
                  const buttons = Array.from(e.currentTarget.querySelectorAll('button'));
                  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                  const next =
                    e.key === 'ArrowDown'
                      ? Math.min(index + 1, buttons.length - 1)
                      : e.key === 'ArrowUp'
                        ? Math.max(0, index - 1)
                        : e.key === 'Home'
                          ? 0
                          : e.key === 'End'
                            ? buttons.length - 1
                            : -1;
                  if (next >= 0) {
                    e.preventDefault();
                    buttons[next]?.focus();
                    buttons[next]?.click();
                  }
                }}
              >
                {[...groups].map(([directory, entries]) => (
                  <div key={directory}>
                    <h5>
                      {directory} / · {entries.length}
                    </h5>
                    {entries.map((item) => (
                      <button
                        className="secondary review-file"
                        disabled={busy || !!body.trim()}
                        key={item.path}
                        aria-pressed={file?.path === item.path}
                        onClick={() => {
                          setSelected(item.path);
                          setAnchor(undefined);
                          setScope('general');
                          setEditId('');
                        }}
                      >
                        <span>{item.path}</span>
                        <small>
                          {changeType(item.status)} · {item.availability}
                          {item.additions !== undefined
                            ? ` · +${item.additions} −${item.deletions}`
                            : ''}
                        </small>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
              {!visibleFiles.length && (
                <p>No files match. Clear the filters to inspect all findings.</p>
              )}
            </aside>
            <div className="review-patch">
              <h4>{file?.path ?? 'No changed file selected'}</h4>
              {file && file.availability !== 'text' && (
                <p role="note">
                  {file.availability}: content cannot be displayed. Inspect this file locally before
                  deciding.
                </p>
              )}
              {file?.patch && (
                <>
                  <div className="review-diff-controls">
                    <button className="secondary" onClick={() => focusHunk(-1)}>
                      Previous hunk
                    </button>
                    <button className="secondary" onClick={() => focusHunk(1)}>
                      Next hunk
                    </button>
                    <span>
                      Lines {offset + 1}–{Math.min(lines.length, offset + 200)} / {lines.length}
                    </span>
                  </div>
                  <div
                    className="review-diff diff-grid"
                    tabIndex={0}
                    aria-label="Git diff"
                    ref={diff}
                  >
                    <table>
                      <caption className="sr-only">
                        Unified diff for {file.path}. Minus removes; plus adds. Select a numbered
                        line to comment.
                      </caption>
                      <thead>
                        <tr>
                          <th>Old</th>
                          <th>New</th>
                          <th>Change</th>
                        </tr>
                      </thead>
                      <tbody>
                        {lines.slice(offset, offset + 200).map((line, index) => (
                          <tr key={offset + index} className={`diff-${line.kind}`}>
                            <td>
                              {line.old &&
                                (editable ? (
                                  <button
                                    className="line-anchor"
                                    disabled={busy}
                                    aria-label={`Comment on old line ${line.old}`}
                                    onClick={() => {
                                      setAnchor({ side: 'old', line: line.old! });
                                      setScope('file');
                                      editor.current?.focus();
                                    }}
                                  >
                                    {line.old}
                                  </button>
                                ) : (
                                  line.old
                                ))}
                            </td>
                            <td>
                              {line.new &&
                                (editable ? (
                                  <button
                                    className="line-anchor"
                                    disabled={busy}
                                    aria-label={`Comment on new line ${line.new}`}
                                    onClick={() => {
                                      setAnchor({ side: 'new', line: line.new! });
                                      setScope('file');
                                      editor.current?.focus();
                                    }}
                                  >
                                    {line.new}
                                  </button>
                                ) : (
                                  line.new
                                ))}
                            </td>
                            <td>
                              <code>
                                <Code text={line.text.slice(0, 4000)} path={file.path} />
                                {line.text.length > 4000 ? '… [display line truncated]' : ''}
                              </code>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="review-diff-controls">
                    <button
                      className="secondary"
                      disabled={!offset}
                      onClick={() => setOffset(Math.max(0, offset - 200))}
                    >
                      Previous lines
                    </button>
                    <button
                      className="secondary"
                      disabled={offset + 200 >= lines.length}
                      onClick={() => setOffset(offset + 200)}
                    >
                      Next lines
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
          <h4>Review feedback</h4>
          {!comments.length && (
            <p>No feedback yet. Add a general comment, select a file, or select a diff line.</p>
          )}
          <ol className="review-comments">
            {comments.map((comment) => (
              <li key={comment.id}>
                <p>
                  <strong>{comment.path ?? 'General review'}</strong>
                  {comment.anchor
                    ? ` · ${comment.anchor.side} line ${comment.anchor.line}${historical ? ' · outdated outside this revision' : ''}`
                    : ''}
                </p>
                <p className="comment-body">{comment.body}</p>
                <small>
                  {comment.createdAt} · Updated {comment.updatedAt}
                </small>
                {editable && (
                  <div>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => {
                        setEditId(comment.id);
                        setBody(comment.body);
                        setSelected(comment.path ?? '');
                        setScope(comment.path ? 'file' : 'general');
                        setAnchor(comment.anchor);
                        editor.current?.focus();
                      }}
                    >
                      Edit comment
                    </button>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => {
                        setComments(comments.filter((item) => item.id !== comment.id));
                        setDirty(true);
                      }}
                    >
                      Remove comment
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ol>
          {editable && (
            <>
              <label>
                Comment scope
                <select
                  value={scope}
                  disabled={busy}
                  onChange={(e) => {
                    setScope(e.target.value);
                    setAnchor(undefined);
                  }}
                >
                  <option value="general">General review</option>
                  {file && <option value="file">File: {file.path}</option>}
                </select>
              </label>
              {anchor && (
                <p>
                  Anchor: {anchor.side} line {anchor.line} · revision {record.number}
                </p>
              )}
              <label>
                Review comment
                <textarea
                  disabled={busy}
                  aria-label="Review comment"
                  ref={editor}
                  value={body}
                  maxLength={4000}
                  onChange={(e) => setBody(e.target.value)}
                />
              </label>
              <div className="start-controls">
                <button
                  className="secondary"
                  disabled={busy || !body.trim() || (comments.length >= 50 && !editId)}
                  onClick={addComment}
                >
                  {editId ? 'Update comment' : 'Add comment'}
                </button>
                <button disabled={busy || !dirty} onClick={() => void save()}>
                  Save draft feedback
                </button>
              </div>
              {unsaved && (
                <p role="status">
                  Unsaved feedback. Add or update the comment, then save the draft before requesting
                  changes or refreshing.
                </p>
              )}
              <button
                ref={requestButton}
                disabled={
                  busy ||
                  dirty ||
                  !!body.trim() ||
                  !record.comments.length ||
                  !record.threadId ||
                  running
                }
                onClick={() => {
                  dialog.current?.showModal();
                  cancelButton.current?.focus();
                }}
              >
                Request Changes…
              </button>
            </>
          )}
          {record.verification && (
            <div role="status">
              <p>
                {record.verification.command}: {record.verification.passed ? 'Passed' : 'Failed'} ·{' '}
                {record.verification.at} ·{' '}
                {record.verification.revision === record.revision
                  ? 'Verified this revision'
                  : 'Earlier revision; rerun to verify current changes'}
              </p>
              <pre className="review-diff" tabIndex={0}>
                {record.verification.output}
              </pre>
            </div>
          )}
        </>
      )}
      {review && !historical && pending && !running && (
        <>
          <p>
            Keep preserves files and the branch for manual integration. AI Office never merges
            automatically.
          </p>
          {review.commands.map((command) => (
            <button
              className="secondary"
              disabled={busy || unsaved}
              key={command}
              onClick={() => void decision('verify', command)}
            >
              Verify: {command}
            </button>
          ))}
          {!review.commands.length && (
            <p>
              Host verification is disabled or no commands are configured. Inspect scripts before
              enabling it.
            </p>
          )}
          <div className="start-controls">
            <button disabled={busy || unsaved} onClick={() => void decision('keep')}>
              Keep isolated changes
            </button>
            <button
              className="secondary"
              disabled={busy || unsaved}
              onClick={() => void decision('reject')}
            >
              Reject and clean up…
            </button>
          </div>
        </>
      )}
      <dialog
        ref={dialog}
        aria-labelledby="request-title"
        onClose={() => requestButton.current?.focus()}
      >
        <h3 id="request-title">Confirm Codex continuation</h3>
        {error && <p role="alert">{error} Cancel and refresh review to recover.</p>}
        <p>
          This submits a write turn and consumes the selected Codex allowance. Only the existing
          authorized session will be resumed.
        </p>
        <p>
          Task: {task.title} ({task.id})<br />
          Worktree: <code>{review?.workspace.path}</code>
          <br />
          Branch: <code>{review?.workspace.branch}</code>
          <br />
          Session: {record?.sessionId}
          <br />
          Thread: {record?.threadId}
          <br />
          Revision: {record?.number} ({record?.revision})
        </p>
        {task.configuration && (
          <p>
            Pinned agent: {task.configuration.name} ·{' '}
            {task.configuration.source === 'legacy'
              ? 'legacy v0.5'
              : `v${task.configuration.profileRevision}`}{' '}
            · {task.configuration.model ?? 'saved default model'}. Current profile edits do not
            apply.
          </p>
        )}
        <h4>Exact feedback</h4>
        <pre className="review-diff" tabIndex={0}>
          {JSON.stringify(record?.comments, null, 2)}
        </pre>
        <p>
          All earlier revision line anchors are outdated. Codex must inspect current code before
          applying feedback.
        </p>
        <div className="start-controls">
          <button ref={cancelButton} className="secondary" onClick={closeDialog}>
            Cancel continuation
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void execute(async () => {
                const saved = await api<ReviewRecord>(`/tasks/${task.id}/review/request-changes`, {
                  revision: record?.revision,
                  version: record?.version,
                  confirmed: true,
                });
                closeDialog();
                setReview((current) => (current ? { ...current, record: saved } : current));
                await refresh();
              })
            }
          >
            Confirm Request Changes
          </button>
        </div>
      </dialog>
    </section>
  );
}
