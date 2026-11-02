import { useEffect, useRef, type KeyboardEvent } from 'react';
import type { Destination } from './destinations.js';
import { nextNavigationIndex } from './navigation-keys.js';

const items: ReadonlyArray<{ id: Destination; icon: string; label: string }> = [
  { id: 'office', icon: '⌂', label: 'Office' },
  { id: 'tasks', icon: '▤', label: 'Tasks' },
  { id: 'workflows', icon: '◇', label: 'Workflows' },
  { id: 'agents', icon: '♙', label: 'Agents' },
  { id: 'settings', icon: '⚙', label: 'Settings' },
];

/** Reveal a focused destination without scrolling the entire document. */
function revealNavItem(nav: HTMLElement, item: HTMLElement) {
  if (!window.matchMedia('(max-width: 680px)').matches) return;
  const bounds = nav.getBoundingClientRect();
  const target = item.getBoundingClientRect();
  if (target.left < bounds.left) nav.scrollLeft -= bounds.left - target.left;
  else if (target.right > bounds.right) nav.scrollLeft += target.right - bounds.right;
}

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
      if (nav && active) revealNavItem(nav, active);
    };
    revealActive();
    window.addEventListener('resize', revealActive);
    return () => window.removeEventListener('resize', revealActive);
  }, [page]);

  const onNavigationKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const nav = event.currentTarget;
    const buttons = Array.from(nav.querySelectorAll<HTMLButtonElement>('.nav-item'));
    const current = buttons.indexOf(event.target as HTMLButtonElement);
    const next = nextNavigationIndex(event.key, current, buttons.length);
    if (next === null) return;
    event.preventDefault();
    const target = buttons[next]!;
    // Arrow/Home/End move keyboard focus only. Enter/Space activate the route,
    // so browsing destinations does not discard a task in progress.
    target.focus({ preventScroll: true });
    revealNavItem(nav, target);
  };

  return (
    <nav ref={navRef} aria-label="Main navigation" onKeyDown={onNavigationKeyDown}>
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
