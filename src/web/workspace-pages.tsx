import type { ReactNode } from 'react';
import type { Destination } from './destinations.js';

export function OfficePage({ children }: { children: ReactNode }) {
  return <div className="office-page" aria-label="Office overview">{children}</div>;
}

export function WorkspacePage({
  page,
  board,
  inspector,
}: {
  page: Exclude<Destination, 'office'>;
  board: ReactNode;
  inspector: ReactNode;
}) {
  return (
    <div className="mission-grid" aria-label={`${page} workspace`}>
      <div className="mission-board">{board}</div>
      <aside className="inspector" aria-label="Agent and connection inspector">
        {inspector}
      </aside>
    </div>
  );
}
