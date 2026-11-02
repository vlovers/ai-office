import type { Destination } from './destinations.js';

const copy: Record<Destination, { title: string; description: string }> = {
  office: {
    title: 'Office overview',
    description: 'Your team at a glance. Select an agent or start a task.',
  },
  tasks: {
    title: 'Tasks',
    description: 'Create, track, and review work in one place.',
  },
  workflows: {
    title: 'Workflows',
    description: 'Follow every stage from coding through approval.',
  },
  agents: {
    title: 'Agents',
    description: 'Manage reusable agent profiles and assignments.',
  },
  settings: {
    title: 'Settings',
    description: 'Connections, access, and trusted repositories.',
  },
};

export function PageHeading({
  page,
  focus,
  onNewTask,
}: {
  page: Destination;
  focus: boolean;
  onNewTask: () => void;
}) {
  const { title, description } = copy[page];
  const heading = focus ? 'Task session' : title;
  const summary = focus ? 'Follow live output, progress, and review for the selected task.' : description;
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">AI OFFICE / {page.toUpperCase()}</div>
        <h1>
          {heading}
          <span>_</span>
        </h1>
        <p>{summary}</p>
      </div>
      <button className="button-link" type="button" onClick={onNewTask}>
        ＋ New task
      </button>
    </div>
  );
}
