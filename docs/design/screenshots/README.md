# PHOSPHOR OS review screenshots

These selected documentation images were captured from the production build during the final deterministic browser smoke test. All tasks, model responses and thread IDs shown are synthetic fixtures, not real Codex sessions or model verification. The registered worktree was disposable and located under `/private/tmp`; no personal repository paths or authentication material are shown. PNGs contain no text metadata.

- [Desktop Mission Control](desktop-mission-control.png): one Codex workstation, saved fixture review, live event history, task composer and connection inspector.
- [Mobile Focus Mode](mobile-focus-mode.png): active fixture task with live output and Stop beside the actual task state. `WAIT_FIXTURE` is the deterministic test prompt, not a command input.

Raw test screenshots, reports, databases and generated build files remain ignored. These two intentional review images are retained for the pull request; no application behavior was changed to produce them.

## Code Review Center v0.5

[v05-feedback.png](v05-feedback.png) shows the production review component with directory
navigation, old/new line numbers, a persisted line comment, explicit Request Changes,
revision-attributed verification and Keep/Reject. This capture uses only synthetic feedback,
a disposable repository and the synthetic SDK fixture thread. The session UUID is a private
fixture database record, not an authentication identifier. The capture contains no user
repository paths or credentials. Reproduce with `npm run build` then
`npm run test:browser:write`; set `AI_OFFICE_SCREENSHOT_DIR` to an existing writable directory.
The test also captures responsive and final-iteration views for local inspection. These are
intentional documentation images; raw runtime databases remain Git-ignored.
