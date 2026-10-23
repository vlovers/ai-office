# Office V4 visual review

Captured from the compiled React application served by the actual Fastify backend
on 2026-10-23, using a disposable SQLite store and Git repository. SDK inference is
a deterministic CLI transport fixture. These are explicitly labeled **test states**,
not live model work. No user repository, credentials, or production database was used.

Scene captures show the complete component at **1440 × 1100** and **390 × 844**
viewports; their height can exceed the viewport. Context captures below show the
actual page viewport, including the test banner. PNGs are intentional review assets.
Raw captures and runtime databases remain outside source control.

| Test state                                                           | Desktop                              | Mobile                              |
| -------------------------------------------------------------------- | ------------------------------------ | ----------------------------------- |
| Two idle profiles                                                    | [Scene](two-idle-desktop.png)        | [Scene](two-idle-mobile.png)        |
| No agents, real profile archival                                     | [Scene](no-agents-desktop.png)       | [Scene](no-agents-mobile.png)       |
| Six profiles, selected overflow profile, four desks                  | [Scene](multiple-agents-desktop.png) | [Scene](multiple-agents-mobile.png) |
| One running task, second agent submitted and waiting on the worktree | [Scene](queued-desktop.png)          | [Scene](queued-mobile.png)          |
| Actual pending workflow approval                                     | [Scene](approval-desktop.png)        | [Scene](approval-mobile.png)        |
| Provider failure, saved failed task                                  | [Scene](failure-desktop.png)         | [Scene](failure-mobile.png)         |

Additional reviewed captures: [active SDK reasoning](active-desktop.png),
[loading](loading-mobile.png), [initial connection failure](unavailable-mobile.png), [saved completion](completed-mobile.png),
[disconnected snapshot](disconnected-mobile.png), [desktop page context](two-idle-desktop-viewport.png),
and [mobile page context](two-idle-mobile-viewport.png).

## Findings

- The office occupies the full content width before operational tools. The projection,
  wall/floor edges, room lighting, furniture depth, and complete character bodies
  remain within the scene at both sizes.
- Earlier four-desk captures exposed collisions between floor nameplates and the
  next row's state bubbles. Nameplates were removed. The roster, selected footer,
  native desk tooltip, and contextual inspector carry names; selection retains a
  visible outline. The foreground plant was moved clear of the fourth desk.
- Dark text on the room's status bubbles was avoided; light labels use dark surfaces.
  Selection has a line/shape and text equivalents. Muted explanatory text remains
  readable against the dark studio surfaces. This is visual inspection, not a claim
  of a complete WCAG conformance audit.
- The zero-agent scene contains no character or synthetic interactive desk. Its CTA
  and the team empty state remain usable. Loading does not imply an idle workforce.
- Roster labels wrap on mobile; controls stay inside their panels. The room's small
  SVG text is supplementary on mobile; the roster and inspector carry readable state.
  Browser smoke verifies no horizontal overflow at 320, 390, 768, 1024, and 1440 px.
- Queued work shows the actual waiting reason and exact task target. Failure and
  completion refer to saved task outcomes. Approval is a workflow checkpoint with
  its own explicit confirmation, never an automatic SDK approval.
- Disconnection changes room state to offline, labels the last saved snapshot, and
  disables contextual actions. All captures here use reduced motion; separate
  browser assertions verify the motion toggle and OS preference override.

Reproduce with `npm run build`, then set `AI_OFFICE_BROWSER_ARTIFACTS` and run
`npm run test:browser:office` followed by `npm run test:browser:workflow`. CI retains
all office scenario captures as `office-v4-browser` and native workflow evidence as
`workflow-browser`. See [implementation and test provenance](../../../OFFICE_V4.md).
