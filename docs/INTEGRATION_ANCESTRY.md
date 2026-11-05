# Local integration ancestry attestation

This is a **read-only, offline** Git guard for stacked feature branches. It is not a release, security or code-review approval. It never fetches refs, updates branches, executes agent code or touches remote credentials.

Create a JSON manifest with the exact current main SHA and an ordered chain of local branch heads:

```json
{
  "version": 1,
  "baseSha": "<40-character-main-commit-sha>",
  "steps": [
    { "name": "feat/first", "sha": "<40-character-commit-sha>" },
    { "name": "feat/second", "sha": "<40-character-commit-sha>" }
  ]
}
```

The second branch must contain the first branch's commit. For independent stacks, use separate manifests. Check out a **clean, trusted repository** and ensure the listed branches have been fetched and created locally as trusted local refs. Run:

```sh
node --test tests/verify-integration-stack.test.mjs
node scripts/verify-integration-stack.mjs /absolute/path/manifest.json /absolute/path/ai-office
```

Exit codes: 0 = exact clean ancestry; 1 = mismatches; 2 = invalid manifest or Git error. JSON results include step-level outcomes. Check GitHub Actions on the **same effective integration tree** separately, confirm file scope, obtain independent review and only then propose integration. A green ancestry result is neither a clean diff nor proof that GitHub CI or native Codex is safe.

Limits: local refs can be modified by the operator or another same-user process; Git objects and on-disk Git configuration are trusted inputs. No remote verification and no protection from concurrent ref changes are claimed. No PR is merged by this script.
