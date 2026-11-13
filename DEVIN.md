# Mastermind for Devin

This repository is now also a Devin plugin. Install the **repository root** via
`manage_plugin(kind="plugin", operation="install", scope="account", plugin_url=...)`
for organization-wide availability (or `personal` for one user's sessions).
Installation requires approval. `local_path` can install an inspected checkout.
The plugin includes the original MIT attribution and reference manual.

## Native execution

The native skill is `skills/mastermind/SKILL.md`, with `workflow.py` beside it.
It uses Devin's injected `register_workflow`, `agent`, `log` and
`WorkflowAgentError`, not ZCode imports. The host invokes builtin
`dynamic-workflows`, copies the template into a persistent engagement directory,
fills the following Python literal, then calls `run_workflow(script_path=...)`:

```python
CONFIG = {
    "source_dir": "/absolute/path/to/installed/plugin",
    "repo_path": "/absolute/path/to/target-checkout",
    "repo": "github.com/owner/repository",
    "commit": "FULL_HEAD_SHA",
    "goal": "The user's objective, verbatim",
    "suite": "python -m unittest discover",  # explicit, inspected project command
    "board": "mastermind",
    "mode": "plan",
    "tier": "standard",  # light | standard | full
    "max_rounds": 3,
    "decisions": [],  # explicit user answers; never record silence as approval
}
```

The fresh target must be clean outside the board. User edits are never committed,
reset or discarded to make this true. Python 3.11+ and git are sufficient on the
Linux controller, plus whatever the project's suite needs. No third-party Python
packages, gauntlet-board scripts, external provider keys or ZCode installation.

`plan` runs architect → planner, persists the contract, exact-scope cards,
coverage denominator, suite baseline and digest, and stops **PLANNED**. Unresolved
questions stop **BLOCKED**. The host shows the actual plan and asks for approval.
`execute` requires `approved_plan_sha256`; `resume` uses the same approval and
durable board. Changed goal/config/contract/cards invalidate approval.
Re-planning before execution may rewrite planning files, but never an active state.
Use the same script and `run_id` to replay successful runtime calls after an
interruption; use `resume` in a later session to continue from board checkpoints.

## Preserved laws

- One controller holds a nonblocking OS lock for the board; seats never write it.
- Brief, return and blind packet land before their downstream dispatch.
- Implementers return scoped full UTF-8 contents and evidence, **not commits**.
  The controller validates the whole bundle before applying; git-free handoffs
  preserve the upstream no-commits law without needing shared-VM permission.
- Controller-run suite, exact scope and evidence gates precede blind jury. The
  suite is re-read from PLAYBOOK §2 every time. A known baseline failure is held
  with its named artifact, never turned into a pass or charged a repair round.
- Fresh jurors/panelists receive only objective/bar/source/evidence/coverage,
  not implementer history or other verdicts. Runtime shared notes are disabled.
- Panels have three independent seats plus a chief; unsupported/malformed
  verdicts fail closed. Majority and chief approval are both required; ties fail.
- Coverage rows cannot disappear and are satisfied only by explicitly checked
  unit IDs; a PASS card does not imply all environments were checked.
- Blocked cards, missing units, held spawns and unavailable checks remain visible
  in RESIDUALS/HANDOFF/REPORT. Neither scope creep nor automatic follow-up cards.

## Deliberate differences and limits

- Cards execute **serially** (`max-in-flight: 1`) to prevent controller writes and
  suite side effects from contaminating concurrent gates. Independent panelists
  still run concurrently on separate VMs. No implicit shared-VM agents.
- No ZCode `hole()` or dashboard: planning and execution are separate invocations,
  and the board + logs are the durable interface. Runtime launch approval is not
  plan approval. There is no `autoApprove` setting in this port.
- Budget: standard permits `max_rounds` juries plus one four-call panel per card;
  full permits a jury and four-call panel each round. Reservations survive resume.
- `mode=fix` is represented by a narrow goal/reproduction and one approved card;
  review-only use should use a normal read-only Devin review rather than this
  write relay. This port supports `plan`, `execute`, `resume`; it does not claim
  full ZCode argument parity. Light tier is one card + mechanical gate; lacking
  independent coverage adjudication is disclosed, not called READY by default.
- Text bundles are capped at 2 MB, with no silent truncation. Binary edits,
  deletions, symlink paths and executable-bit changes are unsupported. User/external
  edits after a checkpoint block resume rather than being overwritten.
- The runtime does not expose same-context verdict healing; malformed verdicts
  fail closed, never get silently rejudged as if formatting were fixed. Blindness
  and forbidden actions are prompt contracts, not sandbox guarantees.
- Evidence auditing is present in full tier, but a dedicated evidence-only repair
  seat, automatic spawn materialization and gauntlet-board tool compatibility are
  not claimed. `state.json` is the native checkpoint, RUNLOG is append-only audit;
  boards are not interchangeable with active ZCode boards. Only resume native boards.
- UI validation requires the user's separate approval and Devin's testing agent;
  missing UI/environment coverage prevents an honest READY.

Offline tests use synthetic seats and temporary git repositories. They do not
execute a cloud engagement. Run `python -m unittest discover -s tests -v`.
For development checks, install `requirements-dev.txt` in an isolated venv, then
run `ruff check skills/mastermind/workflow.py tests/test_devin_workflow.py` and
`mypy --check-untyped-defs skills/mastermind/workflow.py`. The runtime names are
annotated without assigning or replacing Devin's injected functions.

The controller requires a nonempty suite; an absent suite or closing `not_checked`
items cannot produce READY. Scope inventory includes ignored files and file modes,
but never shares ignored contents with agents. Unrelated symlinks are inventoried
without following targets; editing symlinks remains unsupported. Inventory hashes
the full worktree (excluding Git metadata and the board), so large ignored build
or dependency trees increase controller I/O; there is no silent scope exclusion.

Bundle application has explicit `applying`/`applied` checkpoints. Interruption during
`applying` fails closed and requires user reconciliation in a fresh engagement;
the controller never guesses whether a missing file was unapplied or user-deleted.
After `applied`, unchanged work can resume without rewriting product files.
Rejected returns stay in their original round's audit artifacts; subsequent native
resume uses a new round/agent label, subject to the original round cap. Out-of-scope
suite side effects block the card immediately rather than being retried silently.

Checkpoint schema v2 records typed file hashes, modes and links. Legacy boards
first verify every old visible-file digest and path inventory against the live
tree; changed content still blocks. They then stop with `INVENTORY-MIGRATION.json`
and a separate approval digest. Show the newly observed paths and mode baselines
to the user: old checkpoints cannot establish historical ignored-file contents or
permissions. Only after explicit acceptance set
`approved_inventory_migration_sha256` to that digest and resume. Any further tree
change invalidates this approval. A pending legacy bundle and its upgraded before
snapshot are archived in `legacy-pending-audit.json`; its attempt is consumed and
a new round is dispatched instead of replaying ambiguous product writes. The
original round cap still applies. Unknown newer schema versions are not downgraded.
