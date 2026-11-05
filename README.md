# Mastermind

A gated **planning → execution → review → repair** workflow for agentic coding: a persisted
file-based board owns the engagement, and every unit of work runs a blind judging relay —
the thing being judged is never graded by the context that produced it.

```
contract ──► plan (cards + coverage) ──► approval gate (human)
──► per card:  implementer ──► mechanical gate ──► blind jury ──► [escalation panel]
──► spawn triage ──► close check ──► delivery report
```

Mastermind fuses two quality-control systems:

- **[SureForge](https://github.com/Da7-Tech/SureForge)** (MIT, Da7-Tech) — the gated
  lifecycle: contract + decision log, coverage ledger, READY / REPAIR / BLOCKED gates,
  finding triage, honest reporting.
- **[gauntlet-board](https://github.com/nattiini45/gauntlet-board)** (MIT) — the blind
  judging relay (implementer → code gate → blind jury → escalation panel), persisted board
  records, RUNLOG discipline, and the SPAWN marketplace.

The board layout stays compatible with gauntlet-board's `board-lint` / `board-index` /
`gate-fast` / `eval-seat` scripts, which the workflow uses when they are installed and
replaces with agent seats when they are not. See [NOTICE.md](NOTICE.md) for the full
lineage and change record.

## What a run looks like

1. **Contract** — an architect seat reads the workspace and produces an understanding memo,
   acceptance criteria, and a decision log; only the user resolves decision-changing
   ambiguity (a skipped question is never recorded as a decision).
2. **Plan** — a planner maps every criterion to cards, each with exact scope paths (the
   isolation mechanism), a measurable bar, and dependencies, plus a coverage denominator
   (criterion × check × environment) that is never allowed to shrink. The suite command is
   smoke-run now, before any implementer can burn a round on a broken command.
3. **Approval gate** — the human approves, amends, or blocks the contract + card set.
4. **Relay, per card, per round** — a fresh implementer makes the smallest in-scope change
   and must land real evidence on disk; a mechanical gate (suite, scope containment,
   evidence existence, DEFERRED disclosure) runs next; then a **blind juror** who sees only
   the packet judges PASS/FAIL against the bar. Escalations (same gap twice, gate/jury
   contradiction, verdict flip-flop) go to a three-seat panel + chief judge; ties fail.
5. **Spawns** — follow-up work discovered mid-run is proposed (never scope-crept), verified
   against the tree, and created / merged / dropped.
6. **Close** — a read-only closer inventories open cards, undisposed residuals, and missing
   coverage rows; the delivery report says READY / REPAIR / BLOCKED and lists what was
   actually checked and what was not.

Everything persists under `<board>/` inside the target repo: any session — or a human — can
resume, audit, or continue the engagement later. The workflow never commits.

## Install (Devin)

The repository also ships a native Devin plugin, skill and Python workflow. See
[DEVIN.md](DEVIN.md) for organization-wide installation, configuration, approval
gates, preserved laws and explicit differences from the ZCode engine.

## Install (ZCode)

Two pieces, both optional to the other but best together:

```sh
# 1. the engine: the dynamic workflow
mkdir -p ~/.zcode/workflows
cp mastermind.dwf.ts ~/.zcode/workflows/mastermind.dwf.ts

# 2. the manual: this skill
git clone https://github.com/nattiini45/mastermind ~/.zcode/skills/mastermind
```

Then, in a session over the repo you want worked on: *"use mastermind to plan and build X
with review"* — or run the saved workflow `mastermind` with a `goal` argument. Small asks
route to the light tier automatically (`tier=light`); there is nothing to configure.

### Arguments

| arg | default | meaning |
|---|---|---|
| `goal` | — *(required)* | the objective, in the user's own words |
| `mode` | `full` | `full` lifecycle · `plan` (stop at the gate) · `fix` (one failure) · `review` (blind review of `target`) · `resume` (continue a board) |
| `tier` | `standard` | `light` (no relay) · `standard` (gate + jury + escalation panels) · `full` (+ evidence audits, closing panels) |
| `board` | `mastermind` | board directory inside the target repo |
| `suite` | `""` | test-command seed; the live source of truth is the board's PLAYBOOK §2 (amendable mid-run) |
| `maxRounds` | `3` | relay rounds per card |
| `maxInFlight` | `2` | cards executing concurrently |
| `panelPolicy` | `escalation` | `closing` = every judged card's PASS also needs a panel + chief (costly) |
| `autoApprove` | `false` | skip the plan-approval checkpoint |
| `target` | `""` | fix: the failure/repro · review: the artifact path(s) |
| `skillsDir` | `.skills` | project skill packs offered to implementers |
| `gbScripts` | `""` | gauntlet-board scripts dir; empty resolves `<home>/.zcode/skills/gauntlet-board/scripts`; absent → agent-seat fallback |

## Documentation

- [SKILL.md](SKILL.md) — the agent-facing manual: tiers, modes, the laws, what to watch
  while a run is live.
- [references/seats.md](references/seats.md) — every seat, its contract, and its failure
  semantics.
- [references/board-format.md](references/board-format.md) — the `<board>/` file spec
  (CONFIG, PLAYBOOK, RUNLOG grammar, cards, rounds, COVERAGE.csv).
- [references/adapting.md](references/adapting.md) — porting Mastermind to another agent
  harness: primitives to map, laws to preserve, runtime work you can drop.

## License

MIT — see [LICENSE](LICENSE). Lineage and attribution in [NOTICE.md](NOTICE.md)
(SureForge © Da7-Tech, MIT; gauntlet-board © nattiini45, MIT).
