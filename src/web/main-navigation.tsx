import type { Destination } from './destinations.js';

const items: ReadonlyArray<{ id: Destination; icon: string; label: string }> = [
  { id: 'office', icon: '⌂', label: 'Office' },
  { id: 'tasks', icon: '▤', label: 'Tasks' },
  { id: 'workflows', icon: '◇', label: 'Workflows' },
  { id: 'agents', icon: '♙', label: 'Agents' },
  { id: 'settings', icon: '⚙', label: 'Settings' },
];

export function MainNavigation({
  page,
  taskCount,
  onNavigate,
}: {
  page: Destination;
  taskCount: number;
  onNavigate: (destination: Destination) => void;
}) {
  return (
    <nav aria-label="Main navigation">
      {items.map(({ id, icon, label }) => (
        <button
          key={id}
          type="button"
          className={`nav-item ${page === id ? 'active' : ''}`}
          aria-current={page === id ? 'page' : undefined}
          onClick={() => onNavigate(id)}
        >
          <span aria-hidden="true">{icon}</span>
          {label}
          {id === 'tasks' && <span className="nav-count">{taskCount}</span>}
        </button>
      ))}
    </nav>
  );
}
