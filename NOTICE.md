# NOTICE — lineage and change record

Mastermind is an original fusion of two MIT-licensed systems, both named below with their
upstreams. This notice records what comes from where and what changed, so adapters can trace
every law to its source.

## Sources

| | SureForge | gauntlet-board |
|---|---|---|
| repo | `Da7-Tech/SureForge` (maintained fork: `nattiini45/SureForge`) | `nattiini45/gauntlet-board` |
| version adapted | 1.0.0 | current (2026-10) |
| license | MIT © Da7-Tech | MIT © nattiini45 |
| contributed | tiers, four-phase lifecycle, contract + decision log + coverage ledger, READY/REPAIR/BLOCKED gates, finding triage, honest reporting | blind judging relay (implementer → gate → blind jury → escalation panel), persisted board records, RUNLOG discipline, SPAWN marketplace, board lint/index/gate scripts |
| adapted | not verbatim — restructured into workflow seats; attribution kept | board layout kept byte-compatible with its scripts |

## What Mastermind changes

### vs SureForge

- The orchestrating "main session" becomes the workflow script plus a single serialized
  **board clerk** subagent — the sole writer of board files (single-writer discipline,
  mechanically enforced by FIFO asks on one agent).
- The budget seat's arithmetic becomes script-native counters (deterministic, free).
- Runtime concerns SureForge carries by hand — provider outages, retries, rate limits,
  session recovery — are delegated to the workflow runtime; the run journal + resume
  replaces hand-rolled recovery (HANDOFF.md is still written for human and harness readers).

### vs gauntlet-board

- RUNLOG dispatch lines carry `(workflow seat)` instead of an agent id (workflow subagent
  ids are not exposed to the script).
- `board-index` regeneration runs at phase boundaries, not at every card transition
  (per-transition regeneration is an interactive-session law; a workflow run is not one).
- The lead is the script, not an interactive session: dispatch, budget and stop rules are
  code, not prompt discipline.
- The four-phase contract/coverage apparatus from SureForge is layered on top of the relay:
  every card must cover named acceptance criteria, and the coverage denominator is carried
  in `COVERAGE.csv`.

### Publishing changes (2026-11-05, v1.0.0)

- `gbScripts` no longer defaults to a machine-specific absolute path; the empty default
  resolves `<home>/.zcode/skills/gauntlet-board/scripts` at run time (same behavior on the
  author's machine, portable elsewhere).
- `mode=plan` is implemented as documented: contract + cards, stop at the approval gate
  (status `PLANNED`, nothing dispatched; execute later with `mode=resume`). In the
  pre-publish live file the mode was declared but unimplemented and fell through to the
  full lifecycle.

## Attribution

Both sources are MIT. SureForge's discipline is adapted, not copied verbatim; where its law
survives intact (three-round gate cap, the coverage denominator, honest reporting), the
credit is Da7-Tech's. gauntlet-board is the same author as Mastermind, so its contribution
is recorded here as lineage rather than third-party attribution.

Mastermind itself: MIT © 2026 PawCommit Studio — see [LICENSE](LICENSE).
