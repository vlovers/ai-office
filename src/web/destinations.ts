import { decodeTaskNavigation } from './task-navigation.js';

export const destinations = ['office', 'tasks', 'workflows', 'agents', 'settings'] as const;
export type Destination = (typeof destinations)[number];

export function destinationFromHash(hash: string): Destination {
  if (hash.startsWith('#task/')) return 'tasks';
  const slug = hash.replace(/^#\/?/, '').split('/')[0] ?? '';
  if (
    ['compose', 'task-history', 'task-workspace', 'task-workflow', 'code-review-center'].includes(
      slug,
    )
  )
    return 'tasks';
  if (['agent', 'agent-studio'].includes(slug)) return 'agents';
  if (['repositories', 'connection'].includes(slug)) return 'settings';
  return destinations.find((destination) => destination === slug) ?? 'office';
}

/** Derive browser-visible navigation from the URL, including back/forward and direct links. */
export function routeFromHash(hash: string): {
  page: Destination;
  taskPanel: 'details' | 'new';
  view: 'mission' | 'focus';
} {
  return {
    page: destinationFromHash(hash),
    taskPanel: hash === '#compose' ? 'new' : 'details',
    view: decodeTaskNavigation(hash) ? 'focus' : 'mission',
  };
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
