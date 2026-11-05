# Adapting Mastermind to another harness

Mastermind is one engine (`mastermind.dwf.ts`, a ZCode dynamic workflow) implementing a
harness-independent system. This guide is for porting that system elsewhere: another
agentic IDE, a plain multi-agent framework, an SDK script. The engine is the reference
implementation — read it alongside this file; every law cited here is enforced there.

## What to map: the six primitives

The engine uses exactly these capabilities. A port needs an equivalent of each.

| ZCode primitive | what it provides | a port needs |
|---|---|---|
| `agent(name, persona).ask<T>()` | an isolated subagent with a frozen system prompt, returning JSON validated against a typed contract | spawn an isolated one-shot agent per seat/round; validate its reply against the seat's return schema; retry same-agent on malformed output |
| `hole<T>()` | a mid-run checkpoint that parks the workflow until a human fills it | any blocking human input (approval gate, plan amendments) |
| `world.run(cmd, args)` | deterministic command execution with exit code + output | run the suite/gate commands yourself; branch on exit codes, not on an agent's claim |
| `files.*` / `git.*` | read-only workspace views (glob, read, grep; status, log) | equivalent read-only file/git access for the script and read-only seats |
| `channel`/`future` | concurrent card workers bounded by `maxInFlight` | a work queue with N workers and dependency-aware dispatch |
| `artifact.board`/`metrics`/`markdown` | live dashboards + published report cards | optional — a port can log; the board files themselves are the durable UI |

Two differences that matter when mapping:

1. **The runtime owns retries/resume.** Provider outages, rate limits, and session recovery
   are handled by the ZCode workflow runtime (run journal + resume), which is why the
   engine has no hand-rolled retry ladder for infrastructure. A harness without that needs
   it added at the spawn layer — or accept that a crashed run is resumed via `mode=resume`
   (the board is the recovery point; that path works everywhere).
2. **Subagent ids are not visible to the script**, so RUNLOG dispatch lines carry
   `(workflow seat)`. A port with visible ids should log them.

## What to keep: the laws

These are the system. Cut them and you have a generic task queue, not Mastermind.

1. **Single writer.** Exactly one serialized writer (the clerk) touches board files. This
   is what makes the board trustworthy under concurrency and crash-resume. Mechanically
   enforce it (FIFO on one agent / a file lock), don't just ask nicely.
2. **Persist before dispatch.** The brief hits disk before the implementer runs; the return
   hits disk before the gate runs; the jury packet is persisted before the jury runs. An
   unverifiable claim never enters judgment.
3. **Blind judgment.** Jurors and panelists see only the packet (objective, bar, scope,
   evidence paths, round). No implementer history, no other verdicts, no board files. Mint
   them fresh per round; heals re-ask the same agent so a verdict is repaired, never
   recomputed by new eyes.
4. **Mechanical before judgment.** The gate (suite, scope containment, evidence existence,
   DEFERRED disclosure) runs before any jury. Where a command can decide, a command
   decides; agents judge only what commands cannot.
5. **The attribution law.** A gate FAIL is attributable out only by naming the owning card
   or baseline artifact; an unowned attribution is this-card. An owned attribution
   (held-FAIL) consumes no round. This is what makes multi-card isolation honest.
6. **Fail-safe ties, honest disclosure.** Panel ties FAIL. Blocked ≠ failure: blocked
   cards get RESIDUALS rows owned by the user; held cards (budget, dependencies) are
   disclosed. DEFERRED "None" with knowingly-left work is a gate FAIL. Every report states
   what was checked, what was not, and why (READY / REPAIR / BLOCKED — plus PLANNED for the
   plan-only stop).
7. **Coverage is an inventory.** The denominator (criterion × check × environment) never
   shrinks; close checks list missing rows by unit id. A percentage is not an inventory.
8. **Scope is the isolation mechanism.** Cards carry exact path lists; DIFF_STAT outside
   scope is a gate violation; discovered out-of-scope work goes through SPAWN (verified
   create/merge/drop), never scope expansion.
9. **The suite command has one source of truth** — PLAYBOOK §2, amendable mid-run, re-read
   at every use, amendments RUNLOGged. Never let two sources define "the tests".
10. **The workflow never commits.** Commits are the user's. Forbidden actions (deploy,
    delete, purchase, publish, message-people, credentials) are board-configured.

## What you can drop or swap

- **The gauntlet-board scripts** (`board-lint`, `board-index`, `gate-fast`, `eval-seat`)
  are optional. Without them: keep a gate-agent fallback (the engine's), skip mechanical
  board lint (or port the scripts — they are plain Node), and check verdict contracts in
  your own code. The engine degrades this way itself and says so in its report.
- **Dashboards** are presentation. The board files are the state; render them however your
  host renders things.
- **Model tiering** is host-side in the engine (one runtime, subagent model is a setting).
  In a port, run judgment seats on your strongest model and the clerk on a cheap one; the
  clerk persona is lean precisely so this is safe.
- **The personas** are portable prose (they live verbatim in the engine) but the
  **contracts** (typed returns) are the load-bearing half — port the schemas first, then
  adjust wording to your harness's tool names.

## Porting path

1. **Records first.** Stand up the board ([board-format.md](board-format.md)) unchanged —
   it is plain files, works anywhere, and gives your port auditability from day one. If
   you replace it with a database, keep the RUNLOG (append-only, latest-line-wins) and the
   round-file paper trail.
2. **Seats second.** One isolated agent per seat/round ([seats.md](seats.md)), personas
   copied, returns validated against the schemas in the engine. Implement the clerk as a
   single serialized consumer of write tasks.
3. **Control flow third.** The branch dispatch (modes: full / plan / fix / review /
   resume; tiers: light / standard / full) is ~200 lines of the engine and ports almost
   verbatim to any orchestration code. Budgets: jury = 2×cards (4× under closing policy),
   panel = 4 calls, maxRounds default 3, maxInFlight default 2.
4. **Then delete what your runtime already does** (retries, resume, dashboards) — that list
   is the "runtime dividends" section of the engine header.

## Minimal subset (if you port nothing else)

Contract → single card → implementer → gate (suite + scope + evidence-on-disk) → one blind
juror → repair loop capped at 3 rounds → honest report. That is the spine every other
feature (panels, audits, spawns, coverage) bolts onto. Keep laws 1–6 even in the minimal
subset; laws 7–10 are what make it scale past one card.
