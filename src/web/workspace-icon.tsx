export type WorkspaceIconName =
  | 'overview'
  | 'tasks'
  | 'workflows'
  | 'agents'
  | 'settings'
  | 'repository'
  | 'branch'
  | 'execution'
  | 'security'
  | 'context';

const paths: Record<WorkspaceIconName, string> = {
  overview: 'm3 10 9-7 9 7v10h-6v-7H9v7H3Z',
  tasks: 'M5 3h14v18H5Z M8 9l2 2 5-5 M8 16h8',
  workflows: 'm12 3 10 6-10 6L2 9Z M2 13l10 6 10-6 M2 17l10 6 10-6',
  agents:
    'M16 21v-3a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v3 M9 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M17 3a4 4 0 0 1 0 8 M22 21v-3a4 4 0 0 0-3-4',
  settings:
    'm9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3Z M15 12a3 3 0 1 0-6 0 3 3 0 0 0 6 0',
  repository: 'm8 6-6 6 6 6 M16 6l6 6-6 6 M14 3l-4 18',
  branch:
    'M6 8v8 M6 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M6 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M18 8v2a7 7 0 0 1-7 7H9',
  execution: 'M4 3h16v18H4Z m5 4 7 5-7 5Z',
  security: 'm12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6Z m-4 10 3 3 5-6',
  context: 'M5 2h14v20H5Z M8 7h8 M8 11h8 M8 15h5',
};

export function WorkspaceIcon({ name }: { name: WorkspaceIconName }) {
  return (
    <svg
      className="workspace-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
