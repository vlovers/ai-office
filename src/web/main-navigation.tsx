import { useEffect, useRef } from 'react';
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
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const revealActive = () => {
      const nav = navRef.current;
      const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
      if (!nav || !active || !window.matchMedia('(max-width: 680px)').matches) return;
      const bounds = nav.getBoundingClientRect();
      const item = active.getBoundingClientRect();
      // Only scroll the navigation strip; scrollIntoView can unexpectedly
      // move the entire page when restoring a mobile deep link.
      if (item.left < bounds.left) nav.scrollLeft -= bounds.left - item.left;
      else if (item.right > bounds.right) nav.scrollLeft += item.right - bounds.right;
    };
    revealActive();
    window.addEventListener('resize', revealActive);
    return () => window.removeEventListener('resize', revealActive);
  }, [page]);
  return (
    <nav ref={navRef} aria-label="Main navigation">
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
