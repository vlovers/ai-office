# Cross-repository governance audit — 2026-10-27

This is a point-in-time evidence snapshot, not an approval, merge authorization, or assertion that branch protection is configured. Revalidate each PR head and CI before acceptance.

## Verified evidence

| Repository | PR | Verified head | Evidence | Outstanding |
| --- | --- | --- | --- | --- |
| `vlovers/rulewitness` | [#85](https://github.com/vlovers/rulewitness/pull/85) | `9619da8fab62009521c0f820608d32db16e72cae` | [RuleWitness CI](https://github.com/vlovers/rulewitness/actions/runs/40478934550) and [permissions review](https://github.com/vlovers/rulewitness/actions/runs/40478934464) both succeeded. | Independent review and merge authorization; draft PR. |
| `vlovers/grid-atlas` | [#319](https://github.com/vlovers/grid-atlas/pull/319) | `f4af12a7f6897fde8f569e10315f98f8eb5060df` | [Foundation CI](https://github.com/vlovers/grid-atlas/actions/runs/40477605887) succeeded. | Independent review; scope is narrower than repo-wide action pin enforcement. |
| `vlovers/grid-atlas` | [#272](https://github.com/vlovers/grid-atlas/pull/272) | `f9fa229de9f63ed230a6f34e2ac5250b1b3c1ca4` | PR diff inspected: 11 workflows plus action-pin guard and tests. GitHub reported `mergeable: false`; no PR-triggered workflow runs were returned for this head by the commit-run lookup. | Resolve conflict; separate action pinning from unrelated circuit editorial CI additions in `real-archive.yml`; rerun checks and obtain independent review. |

## Action-pin guard observations

The #272 guard requires full immutable external Action SHAs, static local Action paths or Docker digests, and `persist-credentials: false` for checkout. Its tests cover mutable refs, dynamic references, duplicate checkout credential settings, case variants and some ambiguous YAML syntax. It is a line-oriented scanner, not a complete YAML parser; passing it alone does not establish comprehensive workflow safety. The guard does not exist on `grid-atlas` `main` at the time of this inspection.

## Acceptance boundaries

- CI success is evidence for a specific head SHA, not independent approval.
- No branch-protection or required-check configuration was verified in this audit.
- No merge, publication, workflow permission change, or branch protection change is authorized by this document.
- Before merging any of these PRs: refresh the head SHA, inspect the actual base-to-head diff, verify applicable CI, obtain required independent review, and document any unresolved risks.
