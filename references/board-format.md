# The board directory

All Mastermind state persists under `<board>/` (default `mastermind/`) **inside the target
repo**. The board is the single source of truth: it survives sessions, it is what a human
audits, and it stays layout-compatible with the
[gauntlet-board](https://github.com/nattiini45/gauntlet-board) skill's `board-lint` /
`board-index` / `gate-fast` / `eval-seat` scripts. This file is the spec of every file and
format on the board. Read it when reading a board by hand, resuming one, or porting (see
[adapting.md](adapting.md) §Records).

**Two laws govern reads:** the RUNLOG's latest line for a card wins over that card's
frontmatter wherever they disagree; and the board is written by exactly one seat (the
clerk) — edit nothing by hand while a run is live.

## Top-level files

### `CONFIG.md` — board configuration (frozen at init)

```yaml
max-rounds-per-card: 3
jury-call-budget-per-wave: 2x-cards      # "uncapped" under panel-policy: closing
spawned-cards-per-run: 10
auto-promote: false
forbidden-actions: [deploy, delete, purchase, publish, message-people, credentials]
max-in-flight: 2
max-per-model-in-flight: uncapped
spawn-materialization: auto
panel-policy: escalation                 # or "closing"
stop-rule-action: blocked
model-map: harness-side
gate-mode: fast-first
custom-keys: []
```

followed by a `# Board Configuration` heading and one bullet per key. Light tier creates
**only** `CONTRACT.md` + `RUNLOG.md` (no cards, no CONFIG).

### `PLAYBOOK.md` — the living rulebook

Four sections: `## 1. Standing directives (never violate)` (commits are manual; the board
directory is clerk-only), `## 2. Build & evidence commands` — the canonical
`Suite command: \`...\`` line, `## 3. Round lessons` (`PB-<n>` entries banked from
implementer returns, read-back verified), `## 4. Archive (superseded)`.

**§2 is the single source of truth for the suite command.** `args.suite` is only the seed:
a plan-time smoke-run that proves the command defective amends §2 (RUNLOGged), and every
later gate — mechanical or agent — re-reads §2 before running anything. A mid-run clerk
amendment is equally valid. Never trust an external suite string over §2.

### `RUNLOG.md` — append-only history

`# Mastermind RUNLOG` heading, then one line per event, each starting `[<UTC stamp>]`. Line
grammar (the shapes that matter):

```
[stamp] board init (mastermind workflow, tier=…, mode=…, panel-policy=…, …)
[stamp] contract v1 recorded (N criteria, N decisions, N open questions)
[stamp] C-001 created (ready; scope N paths; covers AC-1, AC-2)
[stamp] WAVE 1 OPEN cards=N budget=N
[stamp] plan approved by user — dispatching wave 1
[stamp] C-001 r1 implementer DISPATCHED (workflow seat, tier=…) — brief persisted before dispatch
[stamp] C-001 stage=gate (r1 return landed — r1-return.md persisted)
[stamp] C-001 stage=gate PASS (r1, gate-fast mechanical)          # or "FAIL", or "audit PASS|FAIL"
[stamp] C-001 r1 jury DISPATCHED (workflow seat — packet persisted before dispatch)
[stamp] C-001 verdict r1 PASS (jury)                               # seat: jury | jury2 | panel-<stance> | chief
[stamp] C-001 in-flight->done stage=closed r1 score 8/10           # or in-flight->blocked … reason
[stamp] SPAWN C-002 from jury@C-001.r1 "…" (premise verified: …)  # or "… MERGED onto C-001" / "… DROPPED — …"
[stamp] suite command amended at plan validation (bars cite the corrected command)
[stamp] session-stop (mastermind workflow run complete; HANDOFF.md rewritten)
```

Tail-append only, never mid-file, never reordered. Dispatch lines say `(workflow seat)`
where gauntlet-board would carry an agent id.

### `HANDOFF.md` — the resume entrypoint

`# Mastermind HANDOFF` + `## Board state snapshot`. Rewritten by the clerk at every
session stop: every card's status/stage/round (re-read from the files, not from memory),
what the run did (one line per outcome), budgets (jury calls used/target, rounds), and
next-session boot order. `mode=resume` starts here.

### `RESIDUALS.md` — what is left open

`# Mastermind RESIDUALS` + a 3-column table: `Card | Criterion / finding | Disposition`.
Blocked cards add an `OPEN (blocked card — owner: user)` row. A residual without a
disposition fails the close check.

### `COVERAGE.csv` — the coverage denominator

One row per criterion × check × environment, appended at plan time, never shrunk:

```
unit_id,requirement_id,artifact_path,snapshot_id,contract_version,environment_id,check_kind,required,role,method_id,status,result,evidence_id,evidence_locator,evidence_snapshot,observed_at,reuse_reason,applicability_evidence,applicability_checked_at,finding_ids
```

`status` starts `missing`, `result` `unverified`; evidence columns fill as rows are
satisfied. The close checker inventories missing rows by `unit_id` — coverage is an
inventory, never a percentage.

### `CONTRACT.md` — the engagement contract

`# Mastermind Contract (v1)` with sections: Understanding memo, Acceptance criteria
(`AC-n: text — evidenced by: medium`), Decisions (`question -> decision (by)`), Risks &
assumptions, Exclusions, Open questions. Under 120 lines.

## `cards/` — one markdown file per card

`<id>-<short-slug>.md` (e.g. `C-001-parser-errors.md`). Frontmatter:

```yaml
id: C-001
title: <imperative one-liner>
status: backlog|ready|in-flight|blocked|done|dropped
stage: brief|implement|gate|jury|panel|closed      # done/dropped requires stage closed
profile: code|visual|rubric|trivial
priority: <dispatch order, 1 first>
round: <current relay round>
created-by: conductor|<spawn source>
scope: [exact paths, inline array]                 # the isolation mechanism
bar: n/a|<path under <board>/bars/>
blocked-by: [ids, inline array]
max-rounds: 3
```

Sections: `## Goal` (observable outcome — a state that becomes true), `## Bar excerpt`
(bar text verbatim; `n/a` for code/trivial pending dispatch), `## Verdict log`
(`rN: PASS|FAIL — seat — largest gap: …`), `## Comments` (spawn merges, hold reasons).

`status` is the dashboard column of truth; `stage` refines in-flight (gate/jury/panel).
Spawned cards are created as `status=backlog` with the rationale in Comments and a SPAWN
RUNLOG line.

## `rounds/<card-id>/` — the relay's paper trail

| file | written by | content |
|---|---|---|
| `rN-brief.md` | clerk, **before** dispatch | the round brief verbatim (standing preamble, card, correction target on r≥2, return contract) |
| `rN-return.md` | clerk, after the implementer returns | the return in the exact label shape below |
| `rN-gate-fast.txt` / `rN-gate.md` | clerk | mechanical or agent gate output verbatim |
| `rN-audit.md` | clerk (tier=full) | the evidence auditor's verdict JSON |
| `rN-jury-brief.md` | clerk | the blind packet persisted before the jury is dispatched |
| `rN-jury.md` (and `rN-jury2.md` after a heal) | clerk | verdict JSON (jury, panel stances, chief) |

The return label shape is exact — `CHANGES:` / `EVIDENCE:` / `DIFF_STAT:` / `SKILLS_READ:`
/ `DEFERRED:` / `BLOCKERS:` / `PLAYBOOK_ADDITIONS:` / `SPAWN:`, verbatim values, `"None"`
where empty.

## `bars/` — visual/rubric bar files

Cards with `profile: visual|rubric` point `bar:` at a file here containing `Source: card
<C-id>`, the numbered criteria, and `## Evidence medium`. Code/trivial cards carry their
bar inline (`bar: n/a` in frontmatter; the bar text lives in the card spec and brief).

## Reading order for a human

`HANDOFF.md` → `CONTRACT.md` → `RUNLOG.md` (tail) → the cards you care about →
`rounds/<id>/` for the evidence of a specific verdict. `COVERAGE.csv` and `RESIDUALS.md`
answer "what is still open"; `PLAYBOOK.md` §3 tells you what the board learned.
