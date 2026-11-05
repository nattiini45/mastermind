---
name: mastermind
description: Plan, execute, independently review, repair, or resume a Mastermind engagement using a persisted contract, exact-scope cards, mechanical gates, blind jurors and bounded escalation panels.
---

# Mastermind for Devin

Read `DEVIN.md` at the plugin root and the upstream `references/adapting.md` laws.
Use the native Python template beside this skill, not `mastermind.dwf.ts`.

1. Invoke builtin `dynamic-workflows` before preparing/running this workflow.
   Investigate the target repo, setup, tests, access and working tree first.
   State the proposed graph and agent count before launch. For tiny tasks use
   normal Devin editing, or `tier="light"` (one card and gate, no jury), rather
   than manufacturing a large workflow. Do not silently launch agents just
   because this skill was found during another task.
2. Create and verify a persistent engagement directory. Copy `workflow.py` there
   and replace only `CONFIG = {}` with the literal described in `DEVIN.md`.
   `source_dir` points at this plugin root; `repo_path` is the target checkout;
   `repo` is its cloud name; `commit` is its full immutable HEAD SHA. A fresh
   engagement requires a clean target tree; never commit/discard the user's work
   to satisfy that precondition. Set `mode="plan"` and include the user's goal.
3. Run with `run_workflow(script_path=...)`. The architect's unresolved questions
   block planning/execution: ask the user, put their answers in `decisions`,
   re-plan and present the contract/cards/coverage to the user.
4. Obtain explicit plan approval. In a new script copy set `mode="execute"` and
   `approved_plan_sha256` to the printed digest. Amendments require re-planning
   and fresh approval, not a hand-edited card or `autoApprove` flag. Runtime launch
   permission does not approve an unseen plan. For later continuation use
   `mode="resume"`, the same board/config and approval digest.
5. Wait for completion notifications, not polling. `run_id` resumes runtime
   calls; the durable board permits a new session to reconcile a stopped run.
   The controller is the only board writer. Never edit a live board manually.
6. Deliver `REPORT.md` with READY / REPAIR / BLOCKED (PLANNED at the gate),
   changed paths, missing coverage unit IDs, residuals, checks and limitations.
   Proposals in SPAWN are held for verification and user approval, never silently
   added to scope. The engine never commits, pushes, opens PRs or deploys.

Separate-VM implementers return scoped UTF-8 file contents and evidence, not
commits. The controller validates/applies the bundle and runs the canonical suite
before a fresh blind juror can see the packet. Cards are intentionally serialized.
No shared-VM mode, undocumented ZCode APIs, fake dashboards, automatic third-party
messages or credential access. UI tests require separate user approval and belong
to Devin's testing agent, not workflow seats; mark those coverage rows missing.
