# PHOSPHOR OS — Phase 1.3

The primary visual reference is [phosphor-reference.png](phosphor-reference.png). This iteration adapts its dark phosphor palette, narrow navigation rail, square bordered panels, pixel office, central terminal and right-side inspector to the actual Phase 1.2 capabilities.

## Interface

- Desktop: repository/connection strip, mission heading, illustrated single workstation, real task counters, task history, session terminal and task composer. The right inspector contains the one Codex agent, authentication controls and repository registration.
- Tablet/mobile: panels stack and the navigation becomes a horizontally scrollable strip. The agent/connection inspector comes first on smaller screens to keep setup and Stop accessible. All directory links point to real sections; there are no placeholder pages.
- The original inline SVG office and robot are decoration, not agent telemetry. There is one workstation and no simulated progress, extra provider, approval action, shell input or resource monitor.
- All existing task creation/start/stop, explicit authentication-mode choice, read-only access, event streaming, results, changed-file summaries, persisted history and saved-thread selection remain connected to the existing endpoints. The backend and shared API contracts are unchanged.

## Visual system and accessibility

`src/web/styles.css` defines background, surface, border, text, muted, phosphor, amber, error and cyan tokens. System monospace fonts work offline without fetching assets. The reference image is documentation only; the application draws its own small SVG sprites in `pixel-art.tsx`.

Statuses always have text labels. Selected repositories/tasks expose pressed state; errors remain alerts. A skip link, section anchors, gold focus outlines, labeled form fields and keyboard-scrollable event log support keyboard use. Layout checks cover 320, 390, 768, 1024 and 1440 px.

CRT effects default **off**. The toggle saves only a display preference (`ai-office-crt`) in localStorage; blocked storage does not prevent startup. Enabling it adds static scanlines and a mild heading glow, without flicker, animation or pointer interception. `prefers-reduced-motion: reduce` suppresses both effects regardless of the saved preference, and forced-colors mode suppresses scanlines. No animation or external font is required.

## Verification

Run after installing dependencies:

```sh
npm run typecheck
npm test
npm run test:smoke
npm run build
npm run format:check
npm run test:browser
```

The browser check requires Playwright Chromium. If using a separate browser cache, set `PLAYWRIGHT_BROWSERS_PATH` to its location. Set `AI_OFFICE_SCREENSHOT_DIR` to an existing writable directory to choose the screenshot destination (otherwise the OS temporary directory is used). Screenshots are `ai-office-phosphor-desktop.png` and `ai-office-phosphor-mobile.png` and contain disposable fixture data.

The Phase 1.3 verification run passed TypeScript, 20 unit/integration tests across five files, the one HTTP/SSE smoke test, production build, Prettier and the expanded browser check. No lint script is configured.

The expanded browser fixture exercises keyboard skip/navigation, CRT toggle via keyboard and persistence, reduced-motion suppression, both auth-mode states, repository registration, task launch, real HTTP/SSE delivery of fixture events, history reload, persisted-session resume, cancellation and sanitized failure display. Unit/integration and HTTP/SSE tests also retain restart/recovery coverage. These checks make **no model calls**, access no authentication store and consume no Codex allowance. Historical real model verification remains documented in the Phase 1.2 report; it was not rerun for the visual redesign.

Limitations: one read-only Codex agent; no editing or parallel agents; no interactive SDK approvals; item-level events rather than token deltas or percentage progress. This is an initial visual iteration, not a pixel-for-pixel reproduction of the multi-agent reference. Automated layout and keyboard checks plus screenshot review are not a complete assistive-technology audit. Display preferences are per browser, and existing backend cancellation limitations still apply.
