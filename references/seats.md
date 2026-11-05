# Seats

Every participant in a Mastermind run is a **seat**: a subagent with a frozen persona, an
input contract, and a typed return contract. Personas live verbatim in
`mastermind.dwf.ts`; this file is the operating manual for them — what each seat sees, what
it must return, and how it fails. Read this when inspecting verdicts, debugging a relay, or
porting (see [adapting.md](adapting.md) for the porting view).

Two laws shape everything below:

- **Single writer.** The board clerk is the only seat that ever writes under `<board>/`.
  Every other seat works on the product tree (implementers) or reads everything (judgment
  seats); board mutations happen only through the clerk.
- **Fresh judgment.** Implementers, gates, auditors, jurors and panelists are minted fresh
  per round. The clerk, architect and planner persist for the engagement. Retries re-ask
  the *same* agent (context retained — a format heal must not recompute a verdict), which
  is why judgment seats are fresh-per-round: reuse would anchor them.

## The engagement seats

### board clerk *(persistent, serialized)*

Transcribes. Writes every board file exactly as each task specifies — nothing improvised.
RUNLOG is append-only (`[UTC-stamp] ...` lines, tail-append only); card frontmatter
transitions and RUNLOG lines land in the same edit where the workflow requires atomicity;
PLAYBOOK additions are read back after banking. It reasons about nothing: a law-dense
persona re-reasoned per ask cost the first live run 7+ minutes on init alone, so the clerk
persona is deliberately lean and every ask carries its own format spec.

### contract architect *(persistent)*

Research-and-clarification phase owner. Inspects the workspace before proposing anything;
produces the understanding memo, acceptance criteria (`Criterion`: id / verifiable text /
evidence medium), a decision log (`Decision`: question / decision / `by` — `"user"` or
`"conductor-default (reversible)"`; a skipped question is **not** a decision), risks,
exclusions, and open questions. Decision-changing ambiguity that only the user can resolve
is escalated with options, trade-offs, and a recommendation. Never implements, never edits
files. In `mode=fix` the same persona is re-aimed at failure analysis (`FixAnalysis`:
root cause / violated criterion / smallest approach / exact scope / evidence needed).

### mastermind planner *(persistent)*

Maps every acceptance criterion to cards, inspection units, and verification methods.
Hard laws: ≤3 criteria of code-profile work = exactly ONE card (never a fan-out); verifying
/ containing / auditing other cards' work is a gate/jury/close duty and is FORBIDDEN as a
card; total cards ≤ ceil(criteria / 3). Every card carries exact scope paths (the isolation
mechanism), a **bar** (numbered, measurable, evidence-naming, fail-able — a criterion
nothing on the tree could fail is vacuous and must be rewritten), a profile
(`code | visual | rubric | trivial`), and `blockedBy` dependencies. The coverage
denominator (criterion × check × environment) may never shrink. Bars naming commands are
smoke-run read-only at plan time; a defective suite command is corrected in
`Plan.suiteCommand` (RUNLOGged) instead of left for an implementer to discover.

### builder *(light tier only, fresh)*

Does the whole light-tier engagement directly: small reversible change, evidence on disk,
self-check against every criterion before returning. Never writes the board, never commits.

## The relay seats (per card, per round)

### implementer *(fresh per round)*

One card, one round, fresh context. Smallest in-scope change that closes the card's bar;
everything outside the scope list is forbidden to touch; evidence paths must exist and be
non-empty on return; never writes the board, never commits; a small card (≤3 scope files)
gets ~8 exploratory tool calls before it must act on best evidence. Round ≥ 2 briefs carry
a **correction target**: the prior round's largest gap and the failed approaches — a
repeated approach is a stop, not a retry. After an evidence-audit FAIL the round is
**evidence-only**: reproduce/re-persist exactly the flagged artifacts, touch no product
file. Returns `ImplementerReturn`: changes, evidence (path + what it proves), diff stat,
skills read, DEFERRED (honest disclosure or exactly "None" — the gate audits this),
blockers, playbook additions, and SPAWN entries for discovered out-of-scope work (never
scope expansion).

### evidence auditor *(tier=full only, fresh)*

Read-only forensics between the implementer's return and the gate: every cited evidence
path exists and is non-empty; quoted numbers/hashes match the files (recomputed where
cheap); claimed corroboration is actually present; every DEFERRED item is falsifiable.
Binary `AUDIT: PASS | FAIL` with issues quoted. FAIL freezes the artifact and forces an
evidence-only repair round — the product work stands, the evidence is re-proven.

### code gate *(fresh; or the `gate-fast` script)*

Binary, code-only: suite/build exit codes and canonical output; DIFF_STAT vs the card's
scope (any diff path outside scope is a FAIL with the violation quoted); evidence-path
existence; DEFERRED disclosure audit (knowingly-left work with DEFERRED "None" is a FAIL).
One suite run only. Never judges quality, never edits.

**Fast path:** when `gate-fast.mjs` (from gauntlet-board) exits 0 and the card is not
risk-class (trivial profile, prior gate failure, or script unavailable), its mechanical
PASS stands and no gate agent is spent.

**Attribution law:** a FAIL may be attributed out (`other-card` / `baseline`) ONLY by
naming the owning sibling card id or the exact pre-existing baseline artifact. A bare
attribution with no named owner is reclassified **this-card** (a live close once shipped
stray files on exactly that mis-attribution). A properly attributed-out FAIL is a
**held-FAIL**: the card proceeds to the jury and no round is consumed.

### juror *(fresh per round)*

Blind: sees ONLY the packet — objective, profile, bar, scope, evidence paths, round
number. Never the implementer's history, other verdicts, or board files. Verifies evidence
with its own eyes; numbers in prose are claims until checked against artifacts. PASS only
when every bar criterion holds on evidence personally verified; otherwise FAIL naming the
single largest meaningful gap. Score 0–10, 7+ passing, consistent with the verdict; a
verified clean pass is a pass — no invented criticism. Returns `Verdict` (verdict, score,
largestGap, findings with severity/location/criterion/observation, evidenceChecked,
SPAWN). The persisted verdict is mechanically contract-checked by `eval-seat.mjs` when
available; a VOID verdict triggers a same-agent heal + re-persist, never a re-judge from a
new context.

**Escalation triggers** → panel: same gap twice (normalized-compare of consecutive FAIL
gaps); a jury FAIL contradicting a mechanical gate PASS; a verdict flip-flop (verdict
change + score swing ≥ 3); or `panelPolicy=closing` (every judged card). A PASS that
triggers closing policy with no panel budget left closes with a disclosure instead.

### escalation panel *(3 fresh seats + chief, fresh)*

Same blind packet, three stances: **adversary** (prosecution — presume FAIL; passes only
what survives the attack), **advocate** (defense — steelman as the bar's target audience
would; still fail any explicitly unmet criterion), **auditor** (spec-literalist — every
criterion MET/PARTIAL/MISSED with a measurement; verdict is arithmetic). The **chief
judge** condenses: majority rules, ties FAIL (fail-safe), a verdict citing evidence that
does not exist is seat-invalidated and excluded from the majority. The chief is not a
fourth juror. Costs 4 jury calls.

### trivial close *(not a seat)*

`profile=trivial` cards close at the gate — the gate is their sole judge; no jury round is
spent.

## The triage and close seats

### spawn verifier *(fresh per proposal)*

Every SPAWN entry (from implementers, jurors, panels, reviews — max 5 per return, pool ≤ 20
per run) is verified against the tree before it becomes a card: does the claimed gap exist,
is it already done (closed, verified work is not a defect), does it duplicate an existing
card's scope? Rules `create` / `merge` (fold into a named card) / `drop` with evidence.
The SPAWN marketplace is how work is *proposed* across seats; scope expansion it is not.

### wave-close checker *(fresh, read-only)*

The final inventory, each item with evidence, never narration: every card done/dropped or
blocked with a recorded reason; every RESIDUALS row dispositioned; every required
COVERAGE.csv row satisfied by applicable passing evidence (missing rows listed by unit id —
a percentage is not an inventory); `git status` shows no stray wave artifacts in card
scopes.

### board reconciler *(fresh, read-only — mode=resume)*

Reads the whole board and reports each card's true state. RUNLOG wins over card
frontmatter where they disagree (the correction is noted, not silently applied). Flags
cards whose latest round already landed a return file — those resume with
verify-and-complete briefs instead of restarting. Facts, not plans.

### reviewer *(mode=review, fresh; tier=full: 3-seat panel + chief)*

Blind read-only review of the `target` artifact(s) against the user's question. Same
verdict contract as a juror; findings carry severity, exact location, the violated
criterion or risk, and the checked evidence.

## Budgets and stop rules

- **Jury budget**: `2 × cards` (escalation policy) or `4 × cards` (closing); a panel costs
  4. A card that cannot be judged within budget is **held-jury-budget** → blocked with a
  RESIDUALS row, not silently dropped.
- **Rounds**: `maxRounds` per card (default 3 — SureForge's gate cap fused with gauntlet's
  max-rounds). A FAIL at the last round's cap blocks without a panel.
- **Dependencies**: a card blocked by a blocked dependency is **held-behind-blocked**;
  unsatisfiable dependencies or cycles block the remainder.
- **Stop rule**: `stop-rule-action: blocked` (CONFIG) — blocked cards surface to the user,
  never auto-retry.
