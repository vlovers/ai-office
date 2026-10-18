import React, { useEffect, useRef, useState } from 'react';
import type { AgentProfile } from '../shared/types.js';
type Api = <T>(path: string, body?: unknown) => Promise<T>;
export function AgentStudio({
  profiles,
  api,
  refresh,
  select,
}: {
  profiles: AgentProfile[];
  api: Api;
  refresh: () => Promise<void>;
  select: (id: string) => void;
}) {
  const [editing, setEditing] = useState<AgentProfile | null>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState('');
  const [archived, setArchived] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (editing !== undefined) {
      dialog.current?.showModal();
      dialog.current?.querySelector<HTMLInputElement>('input')?.focus();
    }
  }, [editing]);
  function open(profile: AgentProfile | null) {
    opener.current = document.activeElement as HTMLElement;
    setError('');
    setEditing(profile);
  }
  function close() {
    dialog.current?.close();
    setEditing(undefined);
    setError('');
    opener.current?.focus();
  }
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not save profile.');
    } finally {
      setBusy(false);
    }
  }
  const shown = profiles.filter(
    (profile) =>
      (archived || !profile.archived) &&
      `${profile.name} ${profile.role}`.toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <section
      className="panel agent-studio"
      id="agent-studio"
      tabIndex={-1}
      aria-label="Agent Studio"
    >
      <div className="panel-heading">
        <h2>Agent Studio</h2>
        <span>{profiles.filter((p) => !p.archived).length} active profiles</span>
      </div>
      <p>
        Define reusable Codex profiles. Saved profiles share at most two workers. Edits apply to new
        submissions; existing sessions keep their pinned configuration.
      </p>
      <div className="studio-tools">
        <button onClick={() => open(null)} disabled={busy}>
          ＋ Create agent
        </button>
        <label>
          Find profiles
          <input type="search" value={filter} onChange={(event) => setFilter(event.target.value)} />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={archived}
            onChange={(event) => setArchived(event.target.checked)}
          />
          Show archived profiles
        </label>
        <button className="secondary" disabled={busy} onClick={() => void act(refresh)}>
          Reload profiles
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && editing === undefined && (
        <p className="task-error" role="alert">
          {error}
        </p>
      )}
      {!shown.length && (
        <p className="empty-state">
          No matching profiles. Create an agent or show archived profiles.
        </p>
      )}
      <ul className="profile-list">
        {shown.map((profile) => (
          <li key={profile.id} className="profile-card" data-profile-id={profile.id}>
            <div>
              <h3>
                {profile.name}{' '}
                <span className="badge">
                  v{profile.revision}
                  {profile.archived ? ' · archived' : ''}
                </span>
              </h3>
              <p>{profile.role}</p>
              <p>{profile.description}</p>
            </div>
            <p className="subtle">
              {profile.maximumMode === 'write'
                ? 'Isolated writes permitted with confirmation'
                : 'Read-only preference'}{' '}
              · {profile.model ?? 'Connection default model'}
              <br />
              <code>{profile.id}</code>
            </p>
            <div className="profile-actions">
              <button
                className="secondary"
                disabled={busy}
                onClick={() => open(profile)}
                aria-label={`Edit ${profile.name}`}
              >
                Edit
              </button>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const copy = await api<AgentProfile>(`/agents/${profile.id}/duplicate`, {
                      revision: profile.revision,
                    });
                    setNotice(`Duplicated ${copy.name}. The copy has a new identity.`);
                  })
                }
                aria-label={`Duplicate ${profile.name}`}
              >
                Duplicate
              </button>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api(`/agents/${profile.id}/archive`, {
                      revision: profile.revision,
                      archived: !profile.archived,
                    });
                    setNotice(
                      `${profile.name} ${profile.archived ? 'restored' : 'archived'}. Saved tasks and sessions are retained.`,
                    );
                  })
                }
                aria-label={`${profile.archived ? 'Restore' : 'Archive'} ${profile.name}`}
              >
                {profile.archived ? 'Restore' : 'Archive'}
              </button>
              {!profile.archived && (
                <button className="secondary" onClick={() => select(profile.id)}>
                  Assign task
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {editing !== undefined && (
        <dialog
          ref={dialog}
          aria-labelledby="studio-dialog-title"
          onKeyDown={(event) => {
            if (event.key !== 'Tab') return;
            const controls = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>(
                'input:not(:disabled),textarea:not(:disabled),select:not(:disabled),button:not(:disabled)',
              ),
            );
            const first = controls[0],
              last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }}
          onCancel={(event) => {
            event.preventDefault();
            if (!busy) close();
          }}
        >
          <form
            key={editing?.id ?? 'new'}
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const settings = {
                name: data.get('name'),
                role: data.get('role'),
                description: data.get('description'),
                instructions: data.get('instructions'),
                model: data.get('model') || null,
                maximumMode: data.get('maximumMode'),
              };
              void act(async () => {
                const saved = await api<AgentProfile>(
                  editing ? `/agents/${editing.id}` : '/agents',
                  { ...settings, ...(editing ? { revision: editing.revision } : {}) },
                );
                setNotice(`${saved.name} saved as v${saved.revision}.`);
                close();
              });
            }}
          >
            <h2 id="studio-dialog-title">{editing ? `Edit ${editing.name}` : 'Create agent'}</h2>
            <p>
              Codex only. Guidance is task text and grants no permissions. Do not put secrets in
              profiles.
            </p>
            {error && (
              <p role="alert" className="task-error">
                {error} Close and reopen to load the latest revision if it changed.
              </p>
            )}
            <label htmlFor="studio-name">Agent name</label>
            <input
              id="studio-name"
              name="name"
              defaultValue={editing?.name ?? ''}
              required
              maxLength={80}
            />
            <label htmlFor="studio-role">Role</label>
            <input
              id="studio-role"
              name="role"
              defaultValue={editing?.role ?? ''}
              required
              maxLength={160}
            />
            <label htmlFor="studio-description">Description</label>
            <textarea
              id="studio-description"
              name="description"
              defaultValue={editing?.description ?? ''}
              maxLength={2000}
              rows={2}
            />
            <label htmlFor="studio-instructions">Instructions</label>
            <textarea
              id="studio-instructions"
              name="instructions"
              defaultValue={editing?.instructions ?? ''}
              maxLength={12000}
              rows={5}
            />
            <label htmlFor="studio-model">Model ID (optional)</label>
            <input
              id="studio-model"
              name="model"
              defaultValue={editing?.model ?? ''}
              maxLength={100}
              aria-describedby="studio-model-help"
            />
            <p id="studio-model-help">
              Blank uses the connection default for new sessions. Local login validates against CLI
              model metadata; API model availability is checked by the provider. No automatic
              fallback.
            </p>
            <label htmlFor="studio-mode">Maximum access preference</label>
            <select
              id="studio-mode"
              name="maximumMode"
              defaultValue={editing?.maximumMode ?? 'read-only'}
            >
              <option value="read-only">Read-only</option>
              <option value="write">Isolated writes with explicit confirmation</option>
            </select>
            <p>
              Writes still require authorized server roots and worktree checks. Shell, filesystem,
              tool and network overrides are unavailable. Host verification has a separate operator
              authorization and confirmation.
            </p>
            <div className="profile-actions">
              <button disabled={busy}>{busy ? 'Saving…' : 'Save agent'}</button>
              <button type="button" className="secondary" disabled={busy} onClick={close}>
                Cancel
              </button>
            </div>
          </form>
        </dialog>
      )}
    </section>
  );
}
