/** Original local SVG sprites; no remote assets or simulated telemetry. */
export function PixelBot() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" shapeRendering="crispEdges" aria-hidden="true">
      <path d="M10 2h4v3h4v3h3v12h-4v2H7v-2H3V8h3V5h4z" />
      <path fill="#07231a" d="M8 8h8v2h3v8h-5v-3h-4v3H5v-8h3z" />
      <path d="M8 10h2v3H8zm6 0h2v3h-2zm-4 8h4v2h-4z" />
    </svg>
  );
}

export { PixelOffice } from './office-scene.js';
export type { OfficeAgent, OfficeQueueItem, OfficeRecentTask } from './office-scene.js';
