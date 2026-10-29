export const destinations = ['office', 'tasks', 'workflows', 'agents', 'settings'] as const;
export type Destination = (typeof destinations)[number];

export function destinationFromHash(hash: string): Destination {
  if (hash.startsWith('#task/')) return 'tasks';
  const slug = hash.replace(/^#\/?/, '').split('/')[0] ?? '';
  if (['compose', 'task-history', 'task-workspace', 'task-workflow', 'code-review-center'].includes(slug)) return 'tasks';
  if (['agent', 'agent-studio'].includes(slug)) return 'agents';
  if (['repositories', 'connection'].includes(slug)) return 'settings';
  return destinations.find((destination) => destination === slug) ?? 'office';
}

export function destinationHash(destination: Destination): string {
  return `#${destination}`;
}

export function destinationForSection(id: string): Destination {
  if (id === 'workflows') return 'workflows';
  if (id === 'agent' || id === 'agent-studio') return 'agents';
  if (id === 'repositories' || id === 'connection') return 'settings';
  if (id === 'overview') return 'office';
  return 'tasks';
}
