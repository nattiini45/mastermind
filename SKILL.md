---
name: mastermind
description: Run, inspect, or port Mastermind — a gated planning→execution→review→repair engine where a persisted board (contract, cards, coverage ledger, RUNLOG) drives a blind judging relay per card (implementer → mechanical gate → blind jury → escalation panel). Use when the user invokes "mastermind", asks to plan and execute something with independent review, wants to resume or read a mastermind board, or wants to adapt the system to another agent harness. Not for quick one-file edits that need no review — the workflow routes those to its own light tier.
metadata:
  version: 1.0.0
  tags: [quality-control, planning, review, workflow, board]
---

# Mastermind

Mastermind fuses two QC systems: **SureForge's** gated lifecycle (contract + decision log,
coverage ledger, READY / REPAIR / BLOCKED gates, finding triage, honest reporting) and
**gauntlet-board's** blind judging relay (implementer → mechanical gate → blind jury →
escalation panel), on a file-based board that survives any session. One engine runs it;
this skill is the manual around that engine.

```
contract ─► plan (cards + coverage) ─► approval gate ─► per card:
  implementer ─► gate ─► blind jury ─► [escalation panel] ─► done | blocked
─► spawn triage ─► close check ─► delivery report
```

## The engine

`mastermind.dwf.ts` (this directory) is a ZCode dynamic workflow. Install it as a global
saved workflow, then run it by name:

```sh
mkdir -p ~/.zcode/workflows
cp mastermind.dwf.ts ~/.zcode/workflows/mastermind.dwf.ts
```

In a session over the target repo: "use mastermind", "plan and build X with review", or
"run mastermind on X". All state persists under `<board>/` (default `mastermind/`)
**inside the target repo** — any later session, or a human, resumes from it.

**Dependencies:** the [gauntlet-board](https://github.com/nattiini45/gauntlet-board) skill's
scripts (`board-lint`, `board-index`, `gate-fast`, `eval-seat`) are used when present
(default `<home>/.zcode/skills/gauntlet-board/scripts`, overridable via `gbScripts`). When
absent the workflow substitutes agent seats for those checks and says so in the report —
nothing silently degrades.

## Tiers and modes

| | |
|---|---|
| `tier=light` | contract → build → check. No board, no relay. For one-or-two-file asks. |
| `tier=standard` *(default)* | board + mechanical gate + blind jury + escalation panels on triggers. |
| `tier=full` | standard + per-round evidence auditing and a closing panel on every judged card. |
| `mode=full` *(default)* | the whole lifecycle below, ending in a delivery report. |
| `mode=plan` | contract + cards, **stop at the approval gate**; execute later with `mode=resume`. |
| `mode=fix` | triage one failure (root cause → single fix card) and run its relay. |
| `mode=review` | blind review of an existing artifact (`target`); `tier=full` adds a 3-seat panel + chief. |
| `mode=resume` | reconcile an existing board and continue its live cards. |

Key args: `goal` (required — the objective in the user's words), `suite` (test-command seed;
the live source of truth is the board's PLAYBOOK §2, amendable mid-run), `board`,
`maxRounds` (default 3), `maxInFlight` (2), `panelPolicy` (`escalation` \| `closing`),
`autoApprove`, `target` (for fix/review), `skillsDir` (project skill packs, default
`.skills`), `gbScripts`.

## Laws the host must not break

- **Single writer.** Only the workflow's board clerk writes under `<board>/`. Read board
  files freely; never edit them by hand while a run is live.
- **Blind jury.** Jurors see only their packet — objective, bar, evidence paths, round
  number. Never feed an implementer's history or another verdict into a jury packet.
- **Persist before dispatch.** Briefs land on disk before the implementer runs; returns
  land before the gate runs.
- **The workflow never commits.** Commits are manual. Forbidden actions (deploy, delete,
  purchase, publish, message-people, credentials) are configured on the board and enforced
  by seat personas.
- **RUNLOG wins.** Where a card's frontmatter and the RUNLOG disagree, the RUNLOG's latest
  line for that card is the truth.
- **Blocked ≠ failure.** A blocked card gets a RESIDUALS row owned by the user; held cards
  (jury budget, blocked dependencies) are disclosed in the report, never hidden.

## While a run is live

The approval gate asks for `approved` / `approved-with-changes` (notes are applied verbatim
to contract and cards) / `blocked`. Watch the two dashboards: the **board** (cards moving
backlog → ready → in-flight → gate → jury → panel → done/blocked) and the **relay budget**
(jury calls vs. budget, rounds spent). Escalation panels fire on: same gap twice, a jury
FAIL contradicting a mechanical gate PASS, a verdict flip-flop (≥3 score swing with a
verdict change), or `panelPolicy=closing`.

## Reading and resuming a board

`HANDOFF.md` (rewritten at every session stop) is the resume entrypoint: per-card state,
what the run did, budgets, and next-session boot order. `RUNLOG.md` is the append-only
history of everything the board did. Run `mode=resume` to reconcile and continue — cards
whose last round already landed a return resume with verify-and-complete briefs instead of
restarting from zero.

## References

- **[references/seats.md](references/seats.md)** — every seat (clerk, architect, planner,
  implementer, repair, auditor, gate, juror, panel, chief, spawn verifier, closer,
  reconciler, builder): persona, inputs, output contract, failure semantics. Read when
  inspecting verdicts or debugging a relay.
- **[references/board-format.md](references/board-format.md)** — the `<board>/` directory
  spec: CONFIG, PLAYBOOK, RUNLOG line grammar, card frontmatter, round files, COVERAGE.csv.
  Read when reading or resuming a board by hand.
- **[references/adapting.md](references/adapting.md)** — porting Mastermind to another
  agent harness: the primitives to map, the laws to preserve, the runtime work you can
  drop. Read when the user wants Mastermind in a different system.
