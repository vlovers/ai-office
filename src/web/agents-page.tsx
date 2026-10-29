import type { AgentProfile, AgentId } from '../shared/types.js';
import { AgentStudio } from './agent-studio.js';

type Api = <T>(path: string, body?: unknown) => Promise<T>;

export function AgentsPage({
  profiles,
  api,
  refresh,
  onSelect,
}: {
  profiles: AgentProfile[];
  api: Api;
  refresh: () => Promise<void>;
  onSelect: (id: AgentId) => void;
}) {
  return (
    <section className="agents-destination" aria-label="Agent profiles">
      <div className="destination-intro">
        <h2>Your agents</h2>
        <p>Manage profiles and choose who should handle the next task.</p>
      </div>
      <AgentStudio profiles={profiles} api={api} refresh={refresh} select={onSelect} />
    </section>
  );
}
