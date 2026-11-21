import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { ProjectWorkspace, type ProjectSection } from './project-workspace.js';
import type { Dashboard } from '../shared/types.js';
import './styles.css';
import './workspace-theme.css';

function OrchestrationPreview() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [repositoryId, setRepositoryId] = useState('');
  const [section, setSection] = useState<ProjectSection>('lead');
  const [error, setError] = useState('');
  const refresh = async () => {
    try {
      const response = await fetch('/api/dashboard', {
        cache: 'no-store',
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value = (await response.json()) as Dashboard;
      setDashboard(value);
      setRepositoryId((current) =>
        value.repositories.some((repo) => repo.id === current)
          ? current
          : (value.repositories[0]?.id ?? ''),
      );
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Server disconnected.');
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  return (
    <main className="settings-destination">
      <header className="panel">
        <h1>AI Office · project orchestration</h1>
        <p>Integration preview for #202. Main shell integration is owned by #201.</p>
        <a href="/">Back to workspace</a>
        <label>
          Repository
          <select
            aria-label="Repository"
            value={repositoryId}
            onChange={(event) => setRepositoryId(event.target.value)}
          >
            {dashboard?.repositories.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.name}
              </option>
            ))}
          </select>
        </label>
        <nav aria-label="Project modules">
          {(['lead', 'templates', 'context'] as const).map((value) => (
            <button key={value} aria-pressed={section === value} onClick={() => setSection(value)}>
              {value === 'lead'
                ? 'Lead Agent'
                : value === 'templates'
                  ? 'Workflow templates'
                  : 'Project Context'}
            </button>
          ))}
        </nav>
      </header>
      {error && (
        <p role="alert">
          Disconnected: {error}
          <button onClick={() => void refresh()}>Retry connection</button>
        </p>
      )}
      {!repositoryId && <p>Register a local repository in workspace Settings to begin.</p>}
      {repositoryId && <ProjectWorkspace repositoryId={repositoryId} section={section} />}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<OrchestrationPreview />);
