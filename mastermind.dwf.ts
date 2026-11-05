/* zcode-workflow
description: "Mastermind: a gated planning→execution→review→repair workflow
  fusing sureforge's QC discipline (tiers, four phases, contract + coverage
  ledger, READY/REPAIR/BLOCKED gates, finding triage) with gauntlet-board's
  blind judging relay (implementer → mechanical gate → blind jury → escalation
  panel). Works on any project at user level; all board state persists under
  <board>/ in the target repo and stays compatible with the gauntlet-board
  skill's lint/index/gate scripts."
whenToUse: 'Use for substantial multi-step work in any project that needs a
  verifiable plan, independent review, and evidence-backed delivery — "use
  mastermind", "plan and execute X with review", "run the gauntlet on X". Tier
  routing: small/trivial asks (one or two files, obvious change) go tier=light;
  standard (default) runs the board + relay; full adds evidence auditing and
  closing panels. Modes: full lifecycle (default), plan-only, fix (triage+repair
  one failure), review (blind review of an existing artifact), resume (reconcile
  an existing mastermind board).'
args:
  autoApprove:
    type: boolean
    description: true = skip the plan-approval checkpoint (standard/full full/plan modes).
    default: false
  board:
    type: string
    description: Board directory inside the target repo (workspace-relative).
    default: mastermind
  gbScripts:
    type: string
    description: Path to the gauntlet-board skill's scripts dir (board-lint,
      board-index, gate-fast, eval-seat). Empty (default) resolves to
      <home>/.zcode/skills/gauntlet-board/scripts at run time. Falls back to
      agent seats when absent.
    default: ""
  goal:
    type: string
    description: "The objective: what to plan, build, fix, or review, in the user's
      own words."
    required: true
    default: ""
  maxInFlight:
    type: number
    description: Cards executing concurrently.
    default: 2
  maxRounds:
    type: number
    description: Rounds per card (sureforge's 3-round gate cap fused with gauntlet
      max-rounds).
    default: 3
  mode:
    type: string
    description: full = planning + execution + delivery; plan = contract + cards,
      stop at the approval gate; fix = triage and repair one failure; review =
      blind review of `target`; resume = reconcile and continue an existing
      board.
    default: full
  panelPolicy:
    type: string
    description: escalation = panel only on same-gap-twice / contradiction triggers
      (default); closing = every judged card's PASS also needs a panel+chief
      (costly).
    default: escalation
  skillsDir:
    type: string
    description: Project skills directory to scan for seat craft packs (relative to
      the target repo root).
    default: .skills
  suite:
    type: string
    description: SEED suite command for gate-fast (--suite). The live source of
      truth is PLAYBOOK §2 (clerk-amendable mid-run); e.g. "npm test".
    default: ""
  target:
    type: string
    description: "For mode=fix: the failure description or repro; for mode=review:
      the artifact path(s) to review."
    default: ""
  tier:
    type: string
    description: light = no relay (contract → build → check). standard = board +
      mechanical gate + blind jury + escalation panels. full = adds evidence
      auditing and closing panels on every judged card.
    default: standard
*/
// ═══════════════════════════════════════════════════════════════════════════
// MASTERMIND — planning, execution, review, and repair as one gated workflow.
//
// Fuses:
//   • sureforge 1.0.0 (MIT, Da7-Tech) — tiers, four phases, contract +
//     decision log + coverage ledger, READY/REPAIR/BLOCKED gates, finding
//     triage, honest reporting. Adapted (not verbatim); attribution kept.
//   • gauntlet-board — the blind judging relay (implementer → gate → blind
//     jury → escalation panel), persisted board records, RUNLOG discipline,
//     SPAWN marketplace. Board layout stays compatible with the
//     gauntlet-board skill's lint/index/gate scripts.
//
// User-level law: works on ANY project. All state lives under <board>/
// inside the target repo (the workspace). No repo is named here; the target
// is always the workspace this run starts in.
//
// Runtime dividends (why some gauntlet law is absent here): provider
// outages, retries and rate limits are handled by the ZCode workflow
// runtime, not the script; the run journal + resume covers session recovery
// (HANDOFF.md is still written for human and harness readers).
//
// Adaptations vs the source skills (documented, not drift):
//   • The orchestrator "main session" role becomes the script + a single
//     serialized "board clerk" subagent — the sole writer of board files
//     (the gauntlet single-writer discipline, mechanically enforced by
//     FIFO asks on one agent).
//   • RUNLOG dispatch lines carry "(workflow seat)" instead of an agent id
//     (workflow subagent ids are not exposed to the script).
//   • The budget seat's arithmetic is script-native counters (deterministic).
//   • board-index regeneration runs at phase boundaries, not every
//     transition (per-transition regeneration is an interactive-session law).
// ═══════════════════════════════════════════════════════════════════════════

// ── Args ───────────────────────────────────────────────────────────────────
const tierRaw = typeof args.tier === "string" ? args.tier : "standard";
const tier: "light" | "standard" | "full" = tierRaw === "light" || tierRaw === "full" ? tierRaw : "standard";
const boardDir = String(args.board ?? "mastermind").replace(/\\/g, "/").replace(/\/+$/, "");
const modeRaw = typeof args.mode === "string" ? args.mode : "full";
const mode: "full" | "plan" | "fix" | "review" | "resume" =
  ["plan", "fix", "review", "resume"].includes(modeRaw) ? (modeRaw as "plan" | "fix" | "review" | "resume") : "full";
const goal = String(args.goal ?? "").trim();
const target = String(args.target ?? "").trim();
const suite = String(args.suite ?? "").trim();
const maxRounds = Math.max(1, Math.min(6, typeof args.maxRounds === "number" ? Math.round(args.maxRounds) : 3));
const maxInFlight = Math.max(1, Math.min(4, typeof args.maxInFlight === "number" ? Math.round(args.maxInFlight) : 2));
const panelPolicy: "closing" | "escalation" = args.panelPolicy === "closing" ? "closing" : "escalation";
const autoApprove = args.autoApprove === true;
// gbScripts resolves at run time (not a hardcoded machine path) so the same
// workflow is portable: args override > <home>/.zcode/skills/gauntlet-board/scripts.
let gbScripts = String(args.gbScripts ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
if (gbScripts === "") {
  try {
    const home = await world.run("node", ["-e", "process.stdout.write(require('os').homedir())"]);
    if (home.exitCode === 0) gbScripts = `${home.stdout.trim().replace(/\\/g, "/")}/.zcode/skills/gauntlet-board/scripts`;
  } catch { /* resolution failed — leave empty; agent seats take over */ }
}
const skillsDir = String(args.skillsDir ?? ".skills").replace(/\\/g, "/").replace(/\/+$/, "");
const BOARD_LINT = `${gbScripts}/board-lint.mjs`;
const BOARD_INDEX = `${gbScripts}/board-index.mjs`;
const GATE_FAST = `${gbScripts}/gate-fast.mjs`;
const EVAL_SEAT = `${gbScripts}/eval-seat.mjs`;

const HONESTY = "If a check is impossible to pass, or your instructions contradict each other or the evidence, escalate and say so plainly rather than working around it.";

// Suite-command single source of truth: PLAYBOOK §2 carries the live command
// (clerk-amendable mid-run, RUNLOGged); args.suite is only the seed. The first
// live run froze a defective args.suite while the board already held the
// amendment — one source of truth, re-read at every use, closes that hole.
const SUITE_RUNNER = "const { execSync } = require('child_process'); try { const out = execSync(process.argv[1], { stdio: ['ignore','pipe','pipe'], encoding: 'utf8', cwd: process.cwd(), timeout: 25 * 60 * 1000 }); console.log(out.slice(-4000)); } catch (e) { console.error('EXIT ' + e.status + '\\n' + String(e.stdout || '').slice(-2000) + String(e.stderr || '').slice(-2000)); process.exit(1); }";
let effectiveSuite: string = String(args.suite ?? "").trim();

async function currentSuite(): Promise<string> {
  try {
    const pb = await files.read(`${boardDir}/PLAYBOOK.md`);
    const m = pb.match(/suite command:\s*`([^`]+)`/i);
    if (m && m[1]) { effectiveSuite = m[1]; return m[1]; }
    const none = pb.match(/suite command:\s*none/i);
    if (none) return "";
  } catch { /* no PLAYBOOK yet — fall back to the seed */ }
  return effectiveSuite;
}

async function runSuite(cmd: string): Promise<{ exitCode: number; output: string }> {
  const r = await world.run("node", ["-e", SUITE_RUNNER, cmd], { output: { tail: 16384 } });
  return { exitCode: r.exitCode, output: `${r.stdout}\n${r.stderr}` };
}

// ── Dashboards (declared once, at the top level) ───────────────────────────
artifact.board("board", {
  title: "Mastermind board",
  key: "id",
  status: "status",
  columns: ["backlog", "ready", "in-flight", "gate", "jury", "panel", "blocked", "done"],
  cardTitle: "title",
  detail: [{ field: "round", label: "Round" }, { field: "note", label: "Note" }],
});
artifact.metrics("budget", {
  title: "Relay budget",
  metrics: [
    { field: "juryCalls", label: "Jury calls" },
    { field: "juryBudget", label: "Jury budget" },
    { field: "cardsClosed", label: "Cards closed" },
    { field: "cardsBlocked", label: "Cards blocked" },
    { field: "rounds", label: "Rounds" },
  ],
});

// ── Typed results (JSDoc becomes the field description seats read) ─────────
interface Criterion {
  /** Stable id like AC-1. */
  id: string;
  /** The criterion, phrased so it is verifiable. */
  text: string;
  /** How completion will be evidenced: command, file, capture, calculation. */
  evidence: string;
}
interface Decision {
  /** The question that needed deciding. */
  question: string;
  /** The decision taken. */
  decision: string;
  /** Who decided: "user" or "conductor-default (reversible)". A skipped question is NOT a decision. */
  by: string;
}
interface Contract {
  /** 2-4 sentences: what will be built/fixed/reviewed, for whom, and where. */
  summary: string;
  criteria: Criterion[];
  decisions: Decision[];
  /** Risks and assumptions the user should see. */
  risks: string[];
  /** What is deliberately out of scope. */
  exclusions: string[];
  /** Questions that block execution — empty when none. */
  openQuestions: string[];
}
interface CardSpec {
  /** Card id, C-NNN. */
  id: string;
  /** Imperative one-liner. */
  title: string;
  /** Observable outcome — a state that can become true, not "make it better". */
  goal: string;
  profile: "code" | "visual" | "rubric" | "trivial";
  /** Exact paths this card may touch — the isolation mechanism; everything outside is forbidden. */
  scope: string[];
  /** Numbered, measurable criteria naming the evidence medium. For visual/rubric cards this becomes a bar file. */
  bar: string;
  /** Card ids this card waits on. */
  blockedBy: string[];
  /** Acceptance-criterion ids this card closes. */
  covers: string[];
}
interface CoverageRow {
  /** Inspection unit id (an acceptance criterion or its sub-unit). */
  unit: string;
  /** Card id covering this unit, or "n/a" for a direct check. */
  card: string;
  /** The check that will satisfy the unit. */
  check: string;
  /** The environment the check runs in. */
  environment: string;
}
interface Plan {
  cards: CardSpec[];
  /** The coverage denominator: one row per criterion x check x environment. Do not shrink it. */
  coverage: CoverageRow[];
  /** One paragraph: what chains, what runs in parallel. */
  sequencing: string;
  /** Questions that must be answered before execution — empty when none. */
  openQuestions: string[];
  /** The validated suite command bars cite (amends args.suite when the plan-time smoke-run proved it defective); empty = none. */
  suiteCommand: string;
}
interface PlanApproval {
  /** approved = proceed; approved-with-changes = apply notes then proceed; blocked = stop. */
  decision: "approved" | "approved-with-changes" | "blocked";
  /** Concrete changes to apply (card edits, scope amendments), or the block reason. */
  notes: string;
}
interface SpawnEntry {
  /** Imperative one-liner for the follow-up work. */
  title: string;
  /** Observable outcome. */
  goal: string;
  profile: "code" | "visual" | "rubric" | "trivial";
  /** Exact paths. */
  scope: string[];
  /** Why this is separate work, citing evidence. */
  rationale: string;
}
interface ImplementerReturn {
  /** The card id worked on. */
  card: string;
  /** The round number. */
  round: number;
  changes: { /** Workspace-relative path. */ path: string; /** One line: what changed. */ summary: string }[];
  /** Evidence artifacts — each path must exist and be non-empty on disk. */
  evidence: { /** Workspace-relative path. */ path: string; /** What it proves. */ proves: string }[];
  /** git diff --stat output; when the workspace is not a git repo, one "path | N lines changed" row per touched file. */
  diffStat: string;
  /** Project skills actually read (slugs); empty when none exist. */
  skillsRead: string[];
  /** Knowingly-left work, honestly disclosed — or exactly "None". */
  deferred: string;
  /** Anything blocking — or exactly "None". */
  blockers: string;
  /** Durable lessons worth banking for later rounds (short, imperative). */
  playbookAdditions: string[];
  /** Discovered follow-up work OUTSIDE this card's scope (never scope expansion); empty when none. */
  spawned: SpawnEntry[];
  /** Anything else the orchestrator should know. */
  notes: string;
}
interface AuditVerdict {
  /** Binary audit verdict on the evidence's provenance. */
  audit: "PASS" | "FAIL";
  /** Quoted issues found (empty on PASS). */
  issues: string[];
}
interface GateVerdict {
  /** Binary gate verdict. */
  verdict: "PASS" | "FAIL";
  /** When FAIL: where the failure lives. other-card/baseline failures do not consume this card's round. */
  attribution: "this-card" | "other-card" | "baseline" | "n/a";
  /** Quoted failing output or violations (empty on PASS). */
  violations: string[];
  /** The checks actually run, one line each. */
  checks: string[];
}
interface JurorFinding {
  /** "low" | "medium" | "high". */
  severity: "low" | "medium" | "high";
  /** Where: path or artifact location. */
  location: string;
  /** Which bar criterion is violated (or risk named). */
  criterion: string;
  /** What you observed, with the evidence you checked. */
  observation: string;
}
interface Verdict {
  /** Card id judged. */
  card: string;
  /** Round number judged. */
  round: number;
  verdict: "PASS" | "FAIL";
  /** 0-10; 7+ is the passing range and must be consistent with your verdict. */
  score: number;
  /** The single largest meaningful gap, one sentence (empty on a clean PASS). */
  largestGap: string;
  findings: JurorFinding[];
  /** Evidence paths/commands you personally checked. */
  evidenceChecked: string[];
  /** Follow-up work outside the judged scope (max 5); empty when none. */
  spawned: SpawnEntry[];
}
interface PanelVerdict {
  verdict: "PASS" | "FAIL";
  /** The single largest gap per the panel. */
  largestGap: string;
  /** One line per seat: seat, verdict, score, one-sentence reason. */
  perSeat: string[];
  /** The condensation rationale (max 3 sentences). */
  rationale: string;
  spawned: SpawnEntry[];
}
interface CardOutcome {
  id: string;
  title: string;
  status: "done" | "blocked" | "held-jury-budget" | "held-behind-blocked" | "dropped";
  rounds: number;
  finalScore: number;
  largestGap: string;
  findings: JurorFinding[];
  panelUsed: boolean;
}
interface ReconcileState {
  cards: {
    id: string; title: string; goal: string; profile: CardSpec["profile"];
    status: string; stage: string; round: number;
    scope: string[]; bar: string; blockedBy: string[];
  }[];
  /** Cards whose latest round already landed a return file. */
  returnsLanded: string[];
  residualsOpen: number;
  /** Anything odd found during reconciliation (one line each). */
  note: string;
}
interface SpawnRuling {
  /** The spawn entry title this ruling is about. */
  title: string;
  ruling: "create" | "merge" | "drop";
  /** For merge: the card id to fold into. */
  onto: string;
  /** The evidence for the ruling (what the tree check showed). */
  reason: string;
}
interface CloseCheck {
  /** Cards not done/dropped, with their state. */
  openCards: string[];
  /** RESIDUALS rows lacking a disposition. */
  residualsOpen: string[];
  /** Required coverage rows without applicable passing evidence. */
  coverageMissing: { /** Unit id. */ unit: string; /** Why it is unsatisfied. */ why: string }[];
  /** Whether the working tree is clean of stray artifacts (informational). */
  treeClean: boolean;
  /** Anything else on the checklist that fails. */
  issues: string[];
}
interface FixAnalysis {
  /** One paragraph: the mechanism of the failure. */
  rootCause: string;
  /** The criterion the failure violates (reproduce or trace it first). */
  violatedCriterion: string;
  /** The smallest approach that closes it. */
  approach: string;
  /** Exact paths the fix may touch. */
  scope: string[];
  /** Evidence that will prove the fix (repro + regression). */
  evidenceNeeded: string;
}
interface BoardCard {
  /** Card id. */
  id: string;
  title: string;
  /** Dashboard column: backlog|ready|in-flight|gate|jury|panel|blocked|done. */
  status: string;
  /** Current relay round. */
  round: number;
  /** One-line state note. */
  note: string;
}
interface WorkflowReport {
  conclusion: string;
  findings: { where: string; what: string; evidence: string; status: "verified" | "unconfirmed"; severity: "low" | "medium" | "high" }[];
  /** What this run actually checked and how (commands run, files covered). */
  verified: string[];
  /** What the run did not look at or could not check, and why. */
  notCovered: string[];
}

// ── Personas ───────────────────────────────────────────────────────────────
// Clerk persona is deliberately lean: every ask carries only the format spec
// IT needs, so the persona itself stays cheap to re-read (a law-dense persona
// re-reasoned per ask cost the first live run 7+ minutes on init alone).
const CLERK_PERSONA = `You are the mastermind board clerk — the SINGLE writer of every file under "${boardDir}/". Write exactly what each task says; nothing more, nothing improvised.
- Timestamps: real UTC via \`date -u +%Y-%m-%dT%H:%M:%SZ\`; every RUNLOG line starts [stamp].
- RUNLOG.md is append-only: tail-append or anchor on the LAST line — never mid-file, never reorder.
- Transcribe quoted text, paths, numbers EXACTLY; file-edit tools only, never shell string writes.
- Card frontmatter: id/title/status(backlog|ready|in-flight|blocked|done|dropped)/stage(brief|implement|gate|jury|panel|closed)/profile(code|visual|rubric|trivial)/priority/round/created-by/scope(inline array)/bar/blocked-by(inline array)/max-rounds; sections ## Goal, ## Bar excerpt, ## Verdict log, ## Comments. done/dropped requires stage closed.
- Round returns render EXACTLY the label shape: CHANGES:/EVIDENCE:/DIFF_STAT:/SKILLS_READ:/DEFERRED:/BLOCKERS:/PLAYBOOK_ADDITIONS:/SPAWN:.
${HONESTY}`;

const ARCHITECT_PERSONA = `You are the contract architect — the research-and-clarification phase owner. Before proposing anything, inspect the workspace: read the relevant files, understand the existing implementation and conventions. Produce an understanding memo and a decision log: separate what the user requested from what you propose; separate sourced facts (cite path:line), background knowledge, and inference. Cover three perspectives, each adding a distinct observation: user value, feasibility in THIS workspace, risk/economics. Decision-changing ambiguity that only the user can resolve → escalate with concrete options, trade-offs, and a recommendation. A skipped question is not a decision — record it as unanswered, never as approved. Keep the scope tight: what was asked, plus explicit exclusions. You never implement and never edit files. ${HONESTY}`;

const PLANNER_PERSONA = `You are the mastermind planner — the plan phase owner. Map every acceptance criterion to a card, an inspection unit, and a verification method. Decompose into the smallest independently judgeable cards; coupled parts share one card — never a fan-out. Every card: exact scope paths (the isolation mechanism — everything outside is forbidden), a bar (what done is judged against: numbered, measurable criteria that name the evidence medium and the command that measures it), a profile, and dependencies. Define the coverage denominator: one row per acceptance criterion x check x environment; never shrink it to make coverage look complete. Bars must be fail-able: if nothing on the tree could fail a bar criterion, the criterion is vacuous — rewrite it.

Card-count law (hard): ≤3 acceptance criteria on code-profile work = exactly ONE card. Cards whose goal is verifying, containing, or auditing OTHER cards' work (suite runs, tree containment, close checks) are FORBIDDEN — those are gate/jury/close duties, never cards. Total cards ≤ ceil(criteria / 3).

Bar validation before you return (hard): smoke-run every command your bars name, read-only, and confirm each criterion is failing-possible. If the plan-time suite smoke-run (given to you) shows the suite command itself is defective — usage/spawn errors, not genuine test failures — pin the corrected command in suiteCommand and cite bar criteria against it. An unpassable criterion is amended in the plan BEFORE any implementer burns a round; record the amendment in sequencing.

You propose; you do not dispatch; you never edit files. ${HONESTY}`;

const IMPL_PERSONA = `You are a fresh-context mastermind implementer — one card, one round. Make the smallest in-scope change that closes the card's bar; everything outside the card's scope list is FORBIDDEN to touch. Produce the evidence the bar names: real files on disk (tests, captures, logs) — every evidence path you return must exist and be non-empty when you return. Do not judge or grade your own work — report what is. Never write inside the board directory. Never git commit. If the card is impossible as scoped, or the brief contradicts itself, escalate instead of improvising. ${HONESTY}`;

const REPAIR_PERSONA = `You are a fresh-context evidence-repair seat. The previous round's PRODUCT work passed mechanical checks but its EVIDENCE failed provenance audit. Fix the evidence only: re-produce, re-run, or re-persist exactly the flagged evidence artifacts. You must NOT change any product file outside the flagged evidence; you must NOT touch the board directory. Re-verify what you produce (paths exist, non-empty, numbers recomputed). ${HONESTY}`;

const GATE_PERSONA = `You are a fresh-context mechanical code gate — binary, code-only. Run the card's checks: suite/build exit and canonical output; DIFF_STAT versus the card's scope (any diff path outside scope is a FAIL with the violation quoted); evidence-path existence; DEFERRED disclosure audit (knowingly-left work with DEFERRED "None" is a FAIL). One suite run only. You never judge visual quality, never take screenshots, never measure pixels, never edit any file. Report the binary verdict with quoted failing output.

Attribution law (hard): a FAIL may be attributed out (other-card / baseline) ONLY when you NAME the owning sibling card id, or the exact pre-existing baseline artifact (path + why it predates this round), in your violations or checks. An out-of-scope path owned by no card and no baseline is THIS-CARD — a violation, not an attribution. ${HONESTY}`;

const AUDITOR_PERSONA = `You are a fresh-context evidence auditor — read-only forensics between the implementer's return and the code gate. Verify: every cited evidence path exists and is non-empty; quoted numbers and hashes match what the files actually contain (recompute where cheap — sha256, wc, grep); claimed controls/corroborations are actually present in the artifacts; every DEFERRED item is falsifiable (you can state what would prove it wrong). You run no suite, judge no quality, edit nothing. Binary AUDIT verdict with issues quoted verbatim. ${HONESTY}`;

const JUROR_PERSONA = `You are a fresh-context blind juror — harsh, independent, thorough. You see ONLY the packet: the objective, the bar, the evidence paths, the round number. You never see the implementer's history, other verdicts, or board files — do not go looking for them, and do not read the board directory. Judge only what the packet cites, with your own eyes: read the evidence files yourself; numbers in prose are claims until you verify them against the artifacts. Do not edit any file. Verdict rules: PASS only when every bar criterion is met on evidence you personally verified; otherwise FAIL with the single largest meaningful gap named. Score 0-10 (7+ is the passing range; keep score and verdict consistent). You need not find defects — a verified clean pass is a pass; do not invent criticism. ${HONESTY}`;

const CHIEF_PERSONA = `You are the chief judge. You receive three independent juror verdicts on the same blind evidence plus the round's standard verdict. Condense them into the verdict of record: majority rules; a tie FAILS (fail-safe). Spot-check citations: a verdict citing evidence that does not exist is seat-invalidated and excluded from the majority. You are not a fourth juror — do not re-judge the artifact wholesale. Record per-seat one-liners and a rationale of at most three sentences. ${HONESTY}`;

const VERIFIER_PERSONA = `You verify a proposed follow-up card against the tree, read-only. Check the premise: does the claimed gap actually exist (grep the "missing" symbol, inspect the cited paths)? Is it already done — closed, verified work is NOT a defect? Does it duplicate an existing card's scope? Rule CREATE (premise holds, no overlap), MERGE (folds into an existing card — name it), or DROP (premise false) with the evidence. ${HONESTY}`;

const CLOSER_PERSONA = `You are the wave-close checker — read-only. Verify each item with evidence, never narration: (1) every card file is done/dropped or blocked with a recorded reason; (2) every RESIDUALS.md row has a disposition; (3) every required COVERAGE.csv row is satisfied by applicable fresh-or-reused PASSING evidence — list the missing rows by unit id and why (a percentage is not an inventory); (4) git status shows no stray wave artifacts in the card scopes. Report each checklist item with its evidence. ${HONESTY}`;

const BUILDER_PERSONA = `You are the builder for a light-tier engagement. Do the task directly, keep it small and reversible, inspect existing conventions before changing them. Produce the evidence the contract names — real files that exist when you return. Check your own result against every acceptance criterion before returning; if a criterion cannot be evidenced, say so instead of claiming it. Never write inside the board directory. Never git commit. ${HONESTY}`;

const RECONCILER_PERSONA = `You are the board reconciler — read-only. Read the board directory (${boardDir}/): every card's frontmatter, the RUNLOG tail, RESIDUALS.md. Report each card's true state; where the RUNLOG and a card's frontmatter disagree, the RUNLOG's latest line for that card wins — note the correction needed. Identify which cards' latest round already landed a return file (rounds/<id>/rN-return.md exists). List residuals without dispositions. Report facts, not plans. ${HONESTY}`;

// ── Pure helpers ───────────────────────────────────────────────────────────
const releases = (s: string | undefined) => s === "done" || s === "dropped";
const sameGap = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();
const nextCardId = (existing: string[]): string => {
  let max = 0;
  for (const s of existing) {
    const m = s.match(/^C-(\d+)/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `C-${String(max + 1).padStart(3, "0")}`;
};
const PROFILES = new Set(["code", "visual", "rubric", "trivial"]);
const spawnOk = (e: SpawnEntry | undefined): boolean =>
  Boolean(e && typeof e.title === "string" && e.title.trim() && typeof e.goal === "string" && e.goal.trim() &&
    e.profile !== undefined && PROFILES.has(e.profile) && Array.isArray(e.scope) && e.scope.length > 0 &&
    typeof e.rationale === "string" && e.rationale.trim());
const dashboardColumn = (status: string, stage: string): string =>
  status === "in-flight" ? (["gate", "jury", "panel"].includes(stage) ? stage : "in-flight") : status;
const boardRow = (id: string, title: string, status: string, stage: string, round: number, note: string): BoardCard =>
  ({ id, title, status: dashboardColumn(status, stage), round, note: note.slice(0, 180) });

// Same-agent retry: retries and format-heals re-ask the ONE agent (context
// retained — the reminder carries the correction), never a fresh context.
// Freshness is preserved where it matters: judgment seats are minted fresh
// per round; a format heal re-emits an already-computed verdict.
const remind = (prompt: string, attempt: number): string =>
  attempt === 1 ? prompt : `${prompt}\n\nFORMAT REMINDER: your previous reply did not satisfy the required contract. Re-emit the COMPLETE structured result with every required field.`;

async function retryOn<T>(a: Agent, tries: number, run: (attempt: number) => PromiseLike<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await run(attempt);
    } catch (e) {
      lastErr = e;
      log(`ask attempt ${attempt} failed — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`ask failed after ${tries} attempts`);
}

// ── Clerk persist prompts ──────────────────────────────────────────────────
const clerkInitAsk = (light: boolean) => `Initialize the board directory "${boardDir}/" for this engagement.
${light ? `LIGHT TIER — minimal workspace: create ONLY CONTRACT.md (a "# Mastermind Contract" heading alone — the content lands in the next task) and RUNLOG.md (a "# Mastermind RUNLOG" heading, then one init line: [<timestamp>] board init (mastermind workflow, tier=light)). Nothing else — no cards/ directory, no CONFIG.md.` : `Create, from scratch:
1. CONFIG.md — frontmatter block with EXACTLY these keys and values:
max-rounds-per-card: ${maxRounds}
jury-call-budget-per-wave: ${panelPolicy === "closing" ? "uncapped" : "2x-cards"}
spawned-cards-per-run: 10
auto-promote: false
forbidden-actions: [deploy, delete, purchase, publish, message-people, credentials]
max-in-flight: ${maxInFlight}
max-per-model-in-flight: uncapped
spawn-materialization: auto
panel-policy: ${panelPolicy}
stop-rule-action: blocked
model-map: harness-side
gate-mode: fast-first
custom-keys: []
followed by a "# Board Configuration" heading and one bullet per key noting the value.
2. PLAYBOOK.md — "## 1. Standing directives (never violate)" (add: commits are manual — the workflow never commits; the board directory is written only by the clerk), "## 2. Build & evidence commands" (one canonical line exactly: ${suite ? `Suite command: \`${suite}\`` : "Suite command: none"}), "## 3. Round lessons" (empty), "## 4. Archive (superseded)" (empty).
3. RUNLOG.md — "# Mastermind RUNLOG" heading, then one init line: [<timestamp>] board init (mastermind workflow, tier=${tier}, mode=${mode}, panel-policy=${panelPolicy}, max-rounds=${maxRounds}, max-in-flight=${maxInFlight}${suite ? `, suite: ${suite}` : ", suite: none"}).
4. HANDOFF.md — "# Mastermind HANDOFF" heading plus "## Board state snapshot" saying: initialized, no cards yet.
5. RESIDUALS.md — heading "# Mastermind RESIDUALS" plus the 3-column table header: Card | Criterion / finding | Disposition.
6. COVERAGE.csv — the exact header line:
unit_id,requirement_id,artifact_path,snapshot_id,contract_version,environment_id,check_kind,required,role,method_id,status,result,evidence_id,evidence_locator,evidence_snapshot,observed_at,reuse_reason,applicability_evidence,applicability_checked_at,finding_ids
7. The directory cards/ (empty).
Append one RUNLOG line after creating everything: [<timestamp>] workspace ready (<n> files created).`}`;

const clerkContractAsk = (c: Contract) => `Write the engagement contract to ${boardDir}/CONTRACT.md (replace any skeleton; keep it under 120 lines):
# Mastermind Contract (v1)
## Understanding memo
${c.summary}
## Acceptance criteria
${c.criteria.map((x) => `- ${x.id}: ${x.text} — evidenced by: ${x.evidence}`).join("\n")}
## Decisions
${c.decisions.map((d) => `- ${d.question} -> ${d.decision} (${d.by})`).join("\n")}
## Risks & assumptions
${c.risks.map((r) => `- ${r}`).join("\n")}
## Exclusions
${c.exclusions.map((x) => `- ${x}`).join("\n")}
## Open questions
${c.openQuestions.length ? c.openQuestions.map((q) => `- ${q}`).join("\n") : "- none"}
Then append one RUNLOG line: [<timestamp>] contract v1 recorded (<n> criteria, <n> decisions, <n> open questions).`;

const clerkPlanAsk = (p: Plan) => `Record the approved plan into the board:
1. For EACH card in the plan, create ${boardDir}/cards/<id>-<short-slug>.md with the card format: id=<the card's id from the plan>, status=ready, stage=brief, profile, priority (dispatch order, 1 first), round=0, created-by=conductor, scope=[exact paths inline], bar=n/a for code/trivial or a bar-file path under ${boardDir}/bars/ for visual/rubric, blocked-by=[ids inline], max-rounds=${maxRounds}. Sections: ## Goal (the card's goal), ## Bar excerpt (the bar text verbatim). For visual/rubric cards also create the bar file at the path you put in frontmatter, containing "Source: card <id>", the numbered criteria, and "## Evidence medium".
2. COVERAGE.csv: append one row per coverage entry — unit_id, requirement_id (the criterion id), artifact_path (the card's primary scope path), snapshot_id (HEAD if available else "worktree"), contract_version "v1", environment_id, check_kind, required "true", role "owner", method_id (short check name), status "missing", result "unverified"; leave evidence columns empty. Do NOT rewrite rows, only append.
3. Append one RUNLOG line per card: [<timestamp>] <id> created (ready; scope <n> paths; covers <criteria ids>).
4. Append one RUNLOG line: [<timestamp>] WAVE 1 OPEN cards=<k> budget=<jury budget>.
5. If the plan carries a suiteCommand that differs from the PLAYBOOK §2 "Suite command:" line, update that line to the plan's value and append one RUNLOG line: [<timestamp>] suite command amended at plan validation (bars cite the corrected command).
Here is the plan:
${JSON.stringify({ cards: p.cards, coverage: p.coverage, sequencing: p.sequencing, suiteCommand: p.suiteCommand }, null, 2)}`;

const clerkBriefAsk = (cardId: string, round: number, brief: string) => `Persist this round brief VERBATIM to ${boardDir}/rounds/${cardId}/r${round}-brief.md (create the directory if needed). Then append one RUNLOG line: [<timestamp>] ${cardId} r${round} implementer DISPATCHED (workflow seat, tier=${tier}) — brief persisted before dispatch. Brief:
<<<BRIEF
${brief}
BRIEF>>>`;

const clerkReturnAsk = (cardId: string, round: number, ret: ImplementerReturn) => `Persist the round return and update state:
1. Write ${boardDir}/rounds/${cardId}/r${round}-return.md rendering this result EXACTLY in the label shape (CHANGES: / EVIDENCE: / DIFF_STAT: / SKILLS_READ: / DEFERRED: / BLOCKERS: / PLAYBOOK_ADDITIONS: / SPAWN: — verbatim values, "None" where empty):
${JSON.stringify(ret, null, 2)}
2. Append one RUNLOG line: [<timestamp>] ${cardId} stage=gate (r${round} return landed — r${round}-return.md persisted).
3. Update the card file frontmatter IN THE SAME EDIT: status=in-flight, stage=gate, round=${round}.
4. If PLAYBOOK_ADDITIONS is non-empty: fold each addition into ${boardDir}/PLAYBOOK.md section "## 3. Round lessons" as PB-<next number> entries, then READ THE SECTION BACK to confirm the entries landed, and append one RUNLOG line: [<timestamp>] PLAYBOOK banked <n> additions from ${cardId} r${round} (read-back verified).`;

const clerkGateAsk = (cardId: string, round: number, kind: "gate-fast" | "gate" | "audit", body: string, passed: boolean) => `Persist the gate stage output:
1. Write the following VERBATIM to ${boardDir}/rounds/${cardId}/r${round}-${kind === "gate-fast" ? "gate-fast.txt" : kind === "audit" ? "audit.md" : "gate.md"}:
<<<BODY
${body}
BODY>>>
2. Append one RUNLOG line: [<timestamp>] ${cardId} stage=gate ${kind === "audit" ? `audit ${passed ? "PASS" : "FAIL"}` : kind === "gate-fast" ? "PASS (gate-fast mechanical)" : passed ? "PASS" : "FAIL"} (r${round}).
3. If this is an agent gate PASS: update the card frontmatter stage=jury (same edit).`;

// Batched stage hand-off (C2): gate output + jury packet + stage flip + both
// RUNLOG lines in ONE clerk ask — the two asks this replaces serialized behind
// the same worker lane anyway.
const clerkStageAsk = (cardId: string, round: number, gateFile: string, gateBody: string, packet: string) => `Persist the gate→jury hand-off in ONE pass:
1. Write VERBATIM to ${boardDir}/rounds/${cardId}/r${round}-${gateFile}:
<<<BODY
${gateBody}
BODY>>>
2. Write VERBATIM to ${boardDir}/rounds/${cardId}/r${round}-jury-brief.md:
<<<PACKET
${packet}
PACKET>>>
3. Update the card frontmatter IN THE SAME EDIT SET: stage=jury.
4. Append two RUNLOG lines: [<timestamp>] ${cardId} stage=gate PASS (r${round}, ${gateFile === "gate-fast.txt" ? "gate-fast mechanical" : "gate agent"}); [<timestamp>] ${cardId} r${round} jury DISPATCHED (workflow seat — packet persisted before dispatch).`;

const clerkVerdictAsk = (cardId: string, round: number, seat: string, verdictJson: object) => `Persist a verdict and update the card:
1. Write the following VERBATIM to ${boardDir}/rounds/${cardId}/r${round}-${seat}.md:
${JSON.stringify(verdictJson, null, 2)}
2. Append to the card file's "## Verdict log" section one line: r${round}: ${String((verdictJson as { verdict?: string }).verdict ?? "?")} — ${seat} — largest gap: ${String((verdictJson as { largestGap?: string }).largestGap ?? "none")}.
3. Append one RUNLOG line: [<timestamp>] ${cardId} verdict r${round} ${String((verdictJson as { verdict?: string }).verdict ?? "?")} (${seat}).`;

const clerkCloseAsk = (oc: CardOutcome, residualNote: string) => `Close out card ${oc.id}:
1. Update its frontmatter IN ONE EDIT: status=${oc.status === "done" ? "done" : oc.status.startsWith("held") ? "blocked" : oc.status}, stage=closed, round=${oc.rounds}. (status blocked stays blocked; note the hold reason in the Comments section with today's timestamp.)
2. Append one RUNLOG line: [<timestamp>] ${oc.id} in-flight->${oc.status === "done" ? "done" : "blocked"} stage=closed r${oc.rounds} ${oc.status === "done" ? `score ${oc.finalScore}/10` : `reason: ${oc.largestGap || oc.status}`}.
3. ${residualNote ? `Append one row to ${boardDir}/RESIDUALS.md: ${oc.id} | ${oc.largestGap || residualNote} | OPEN (blocked card — owner: user)` : "No RESIDUALS row needed — card closed clean."}`;

const clerkRunlogAsk = (line: string) => `Append exactly one line to ${boardDir}/RUNLOG.md (tail-append): ${line}
Use the current UTC timestamp from \`date -u\` in the [bracket] stamp. Reply with the line you wrote.`;

// ── Run state ──────────────────────────────────────────────────────────────
const clerk = agent("board clerk", CLERK_PERSONA);
let juryCalls = 0;
let roundsSpent = 0;
let juryBudgetTarget = 0;
let closedCount = 0;
let blockedCount = 0;
const spawnPool: { entry: SpawnEntry; source: string }[] = [];
const collectSpawns = (entries: SpawnEntry[] | undefined, source: string) => {
  if (!entries) return;
  for (const e of entries.slice(0, 5)) {
    if (spawnOk(e) && spawnPool.length < 20) spawnPool.push({ entry: e, source });
  }
};
const checked: string[] = [];
const limits: string[] = [];
const budgetRow = () => ({ juryCalls, juryBudget: juryBudgetTarget, cardsClosed: closedCount, cardsBlocked: blockedCount, rounds: roundsSpent });

// ── Workspace load (setup — no phase marker) ───────────────────────────────
let gitClean: boolean | undefined;
let gitBranch = "";
try {
  const st = await git.status();
  gitClean = st.clean;
  gitBranch = st.branch ?? "";
} catch { gitClean = undefined; }
let existingFiles: string[] = [];
try { existingFiles = await files.glob(`${boardDir}/**/*.md`); } catch { existingFiles = []; }
const hasBoard = existingFiles.some((p) => p === `${boardDir}/CONFIG.md`);
let projectSkills: string[] = [];
try { projectSkills = await files.glob(`${skillsDir}/*/SKILL.md`); } catch { projectSkills = []; }
log(`Workspace: ${gitClean === undefined ? "not a git repo" : `git ${gitBranch || "(detached)"}${gitClean ? ", clean" : ", dirty"}`}; board "${boardDir}" ${hasBoard ? "EXISTS — resume path available" : "does not exist yet"}; project skills: ${projectSkills.length ? `${projectSkills.length} pack(s)` : "none"}`);

const blockedReport = (why: string): WorkflowReport => ({
  conclusion: `BLOCKED before any work: ${why}`,
  findings: [],
  verified: [],
  notCovered: ["everything — the engagement never started"],
});

// ═══════════════════════════ Flow helpers ═══════════════════════════════════
async function establishContract(lightMode: boolean): Promise<Contract> {
  phase("Establish the contract");
  const focus = lightMode
    ? `Keep it lean (light tier): 2-4 acceptance criteria, only decisions that truly need recording.`
    : `Be thorough: every acceptance criterion verifiable, every material decision logged.`;
  const architect = agent("contract architect", ARCHITECT_PERSONA);
  const contract = await retryOn(architect, 2, (n) =>
    architect.ask<Contract>(remind(`The user's objective: "${goal}"${target ? `\nFocus material: ${target}` : ""}\nWorkspace: this repo${gitClean === undefined ? " (not a git repo)" : gitClean ? " (clean tree)" : " (dirty tree)"}.\nProduce the understanding memo + decision log as the structured result.${focus}\n${projectSkills.length ? `Project skill packs exist at ${skillsDir}/ — read any that bear on this objective.` : ""}`, n)));
  await clerk.ask(clerkInitAsk(lightMode));
  await clerk.ask(clerkContractAsk(contract));
  return contract;
}

async function planCards(contract: Contract): Promise<Plan> {
  phase("Plan the cards and coverage");
  // Probe-health smoke-run (C6): the suite command is proven alive and its
  // baseline recorded BEFORE any implementer burns a round on it — the first
  // live run lost 2h to an implementer discovering an unpassable suite arg.
  const seedSuite = await currentSuite();
  let suiteBaseline = "no suite configured";
  if (seedSuite) {
    try {
      const r = await runSuite(seedSuite);
      const tail = r.output.split(/\r?\n/).filter(Boolean).slice(-3).join(" | ").slice(0, 300);
      suiteBaseline = `exit ${r.exitCode}${tail ? ` — ${tail}` : ""}`;
    } catch (e) { suiteBaseline = `spawn failure: ${e instanceof Error ? e.message : String(e)}`; }
    checked.push(`plan-time suite smoke-run (${seedSuite}): ${suiteBaseline.slice(0, 160)}`);
  }
  const planner = agent("mastermind planner", PLANNER_PERSONA);
  const plan = await retryOn(planner, 2, (n) =>
    planner.ask<Plan>(remind(`Contract: ${JSON.stringify(contract, null, 2)}\nPlan-time suite smoke-run: ${suiteBaseline}\nDecompose into cards. Card ids: ${nextCardId([])} onward (C-001...). Bar criteria must name the evidence medium${seedSuite ? ` and cite the suite command (\`${seedSuite}\` — or the corrected suiteCommand if the smoke-run proved it defective)` : "; no suite is configured, so bars must name file/artifact evidence"}.${projectSkills.length ? `\nProject skills available: ${projectSkills.join(", ")}.` : ""}`, n)));
  await clerk.ask(clerkPlanAsk(plan));
  const liveSuite = await currentSuite();
  if (plan.suiteCommand && plan.suiteCommand !== seedSuite) log(`suite command amended at plan validation: ${seedSuite || "(none)"} -> ${plan.suiteCommand}`);
  juryBudgetTarget = panelPolicy === "closing" ? 4 * Math.max(1, plan.cards.length) : 2 * Math.max(1, plan.cards.length);
  for (const c of plan.cards) report(boardRow(c.id, c.title, "ready", "brief", 0, "planned"), "board");
  report(budgetRow(), "budget");
  // Mechanical board validation
  let lintOk = false;
  for (let attempt = 0; attempt < 2 && !lintOk; attempt++) {
    const lint = await world.run("node", [BOARD_LINT, boardDir], { output: { tail: 8192 } }).catch(() => null);
    if (lint === null) { limits.push("board-lint.mjs unavailable — board layout not mechanically validated"); break; }
    if (lint.exitCode === 0) { lintOk = true; checked.push(`board-lint OK (${boardDir})`); break; }
    log(`board-lint flagged issues — clerk repairs (attempt ${attempt + 1})`);
    await clerk.ask(`${lint.stdout}\n${lint.stderr}\nFix every ERROR above (warnings are acceptable). Re-read each file after editing.`);
  }
  await world.run("node", [BOARD_INDEX, boardDir], { output: "discard" }).catch(() => null);
  return plan;
}

async function approveGate(plan: Plan, contract: Contract): Promise<"proceed" | "blocked"> {
  if (autoApprove || mode === "fix") return "proceed";
  const approval = await hole<PlanApproval>(
    "Approve the contract and card set",
    `Plan gate — approve the contract and card set, or amend, or block.\n| # | card | profile | scope | after | covers |\n|---|---|---|---|---|---|\n${plan.cards.map((c) => `| ${c.id} | ${c.title.slice(0, 60)} | ${c.profile} | ${c.scope.join(", ").slice(0, 80)} | ${c.blockedBy.join(",") || "—"} | ${c.covers.join(",") || "—"} |`).join("\n")}\nCriteria: ${contract.criteria.length} | Coverage rows: ${plan.coverage.length} | Cards: ${plan.cards.length} (≤ ceil(criteria/3) required)\nSUMMARY: ${contract.summary}\nOPEN QUESTIONS: ${contract.openQuestions.length ? JSON.stringify(contract.openQuestions) : "none"}\nSUITE: ${await currentSuite() || "none"} (smoke-run at plan time)\nReply decision: approved | approved-with-changes (notes = concrete amendments) | blocked (notes = reason).`,
  );
  if (approval.decision === "blocked") return "blocked";
  if (approval.decision === "approved-with-changes" && approval.notes.trim()) {
    await clerk.ask(`The user approved the plan WITH CHANGES. Apply these amendments to the contract (${boardDir}/CONTRACT.md) and/or card files exactly as stated, re-run nothing, and append one RUNLOG line: [<timestamp>] plan approved with changes — amendments applied. Amendments:\n${approval.notes}`);
  } else {
    await clerk.ask(clerkRunlogAsk("plan approved by user — dispatching wave 1"));
  }
  return "proceed";
}

function briefFor(card: CardSpec, round: number, strategy: string, lastGap: string, failed: { round: number; gap: string }[], evidenceOnly: boolean): string {
  const skills = projectSkills.length ? `\n\n## Project skills (read what applies)\n${projectSkills.join("\n")}\n\nReturn-contract item SKILLS_READ must list the slugs you read.` : "";
  const correction = round > 1
    ? `\n\n## Correction target (strategy MUST change — a repeated approach is a stop)\nPrior round's largest gap: "${lastGap}".\nFailed approaches (do NOT retry):\n${failed.map((f) => `- r${f.round}: ${f.gap}`).join("\n")}\nYour strategy this round must be materially different.`
    : "";
  const evidenceNote = evidenceOnly
    ? `\n\n## EVIDENCE-ONLY ROUND (audit failed)\nThe product work stood; the EVIDENCE failed provenance. Re-produce/re-persist exactly the flagged evidence. Touch NO product file outside the flagged evidence.`
    : "";
  return `# ${card.id} — ${card.title} — round ${round}

## Standing preamble
You are a fresh-context implementer. Smallest in-scope change that closes the bar. Everything outside the scope list is FORBIDDEN. Every evidence path you cite must exist and be non-empty when you return. Never write inside "${boardDir}/". Never git commit. Size budget: a small card (≤3 scope files) gets at most ~8 exploratory tool calls — then act on best evidence; escalate only when the bar is impossible as scoped or the needed fix is outside scope.${evidenceNote}

## Card
- Goal: ${card.goal}
- Profile: ${card.profile}
- Scope (the only paths you may touch): ${card.scope.join(", ")}
- Bar (done is judged against this): ${card.bar}
- Covers acceptance criteria: ${card.covers.join(", ") || "n/a"}
- Round strategy: ${strategy}${correction}${skills}

## Return contract (every field, exact labels)
CHANGES: one line per file
EVIDENCE: path — what it proves
DIFF_STAT: git diff --stat rows; if the workspace is not a git repo, one "path | N lines changed" row per touched file
SKILLS_READ: slugs or None
DEFERRED: None or honest disclosure
BLOCKERS: None or description
PLAYBOOK_ADDITIONS: bullets or None
SPAWN: none, or follow-up entries (title/goal/profile/scope/rationale) for work OUTSIDE this card's scope`;
}

function blindPacket(card: CardSpec, round: number, evidence: { path: string; proves: string }[]): string {
  return `BLIND JURY PACKET — card ${card.id}, round ${round}
You are blind: judge ONLY this packet. Do not read the board directory "${boardDir}/", other verdicts, or any implementer session. Do not edit any file.
OBJECTIVE: ${card.goal}
PROFILE: ${card.profile}
BAR (all criteria must hold): ${card.bar}
SCOPE: ${card.scope.join(", ")} — judge only these paths.
EVIDENCE (verify with your own eyes — prose numbers are claims until you check them):
${evidence.length ? evidence.map((e) => `- ${e.path} — ${e.proves}`).join("\n") : "- none supplied — judge from the artifacts the paths name"}
ROUND: ${round}
Verdict rules: PASS only when every bar criterion holds on evidence you verified; else FAIL naming the single largest meaningful gap. Score 0-10, 7+ = passing range, consistent with the verdict.
${HONESTY}`;
}

async function runPanel(card: CardSpec, round: number, packet: string, standardVerdict: Verdict): Promise<PanelVerdict> {
  const seats: { seat: string; persona: string }[] = [
    { seat: "adversary", persona: `${JUROR_PERSONA}\n\nADVERSARY STANCE (prosecution): presume FAIL and build the strongest honest case that the artifact misses the bar; it passes only if it survives your attack.` },
    { seat: "advocate", persona: `${JUROR_PERSONA}\n\nADVOCATE STANCE (defense): steelman the artifact and judge as the bar's target audience would — would they notice the gap, would they care — while still failing any explicitly unmet bar criterion.` },
    { seat: "auditor", persona: `${JUROR_PERSONA}\n\nAUDITOR STANCE (spec-literalist): decompose the bar into explicit checkable criteria; score each MET/PARTIAL/MISSED with a measurement, never an opinion; any MISSED criterion is a FAIL. VERDICT is arithmetic.` },
  ];
  const verdicts = await Promise.all(seats.map((s) => {
    const seat = agent(`panel ${s.seat} ${card.id}`, s.persona);
    return retryOn(seat, 2, (n) =>
      seat.ask<Verdict>(remind(`${packet}\n\nPANEL ROUND: an escalation panel is adjudicating this card (round ${round}). Independent of the other panelists, produce your full verdict.`, n)),
    ).then(async (v) => {
      await clerk.ask(clerkVerdictAsk(card.id, round, `panel-${s.seat}`, v as unknown as object));
      return v;
    });
  }));
  const chiefSeat = agent(`chief judge ${card.id}`, CHIEF_PERSONA);
  const chief = await retryOn(chiefSeat, 2, (n) =>
    chiefSeat.ask<PanelVerdict>(remind(`The blind packet under panel review (round ${round}):\n<<<PACKET\n${packet}\nPACKET>>>\n\nThe three panel verdicts:\n${JSON.stringify(verdicts, null, 2)}\n\nThe round's standard verdict for context:\n${JSON.stringify(standardVerdict, null, 2)}\n\nCondense into the verdict of record (majority rules; tie FAILS; seat-invalidate a verdict citing absent evidence).`, n)));
  await clerk.ask(clerkVerdictAsk(card.id, round, "chief", chief as unknown as object));
  juryCalls += 4;
  return chief;
}

async function runRelay(card: CardSpec, startRound: number, verifyAndComplete: boolean): Promise<CardOutcome> {
  const failed: { round: number; gap: string }[] = [];
  let lastGap = "";
  let prevVerdict = "";
  let prevScore = -1;
  let panelUsed = false;
  let evidenceOnly = false;
  let lastGateFail = false;
  for (let round = startRound; round < startRound + maxRounds; round++) {
    roundsSpent++;
    const brief = briefFor(card, round, verifyAndComplete && round === startRound ? "verify-and-complete: prior rounds landed work on disk — verify what exists, complete the remainder, do not restart from zero" : evidenceOnly ? "evidence-only repair" : round === startRound ? "first attempt" : "repaired approach — must differ from failed approaches", lastGap, failed, evidenceOnly);
    await clerk.ask(clerkBriefAsk(card.id, round, brief));
    const implementer = agent(`implementer ${card.id} r${round}`, evidenceOnly ? REPAIR_PERSONA : IMPL_PERSONA);
    const ret = await retryOn(implementer, 2, (n) =>
      implementer.ask<ImplementerReturn>(remind(brief, n)));
    collectSpawns(ret.spawned, `implementer@${card.id}.r${round}`);
    await clerk.ask(clerkReturnAsk(card.id, round, ret));
    report(boardRow(card.id, card.title, "in-flight", "gate", round, "return landed — gating"), "board");
    const packet = blindPacket(card, round, ret.evidence);

    // ── Gate stage (suite command from PLAYBOOK §2 — the amendable SSOT) ──
    let gatePass = false;
    let gateNote = "";
    const liveSuite = await currentSuite();
    let gf: { exitCode: number; stdout: string; stderr: string } | undefined;
    try {
      gf = await world.run("node", [GATE_FAST, boardDir, card.id, "--round", String(round), ...(liveSuite ? ["--suite", liveSuite] : [])], { output: { tail: 16384 } });
    } catch { gf = undefined; }
    const riskClass = card.profile === "trivial" || lastGateFail || !gf || gf.exitCode !== 0;
    if (gf && gf.exitCode === 0 && !riskClass) {
      gatePass = true;
      gateNote = "gate-fast mechanical PASS";
      await clerk.ask(clerkStageAsk(card.id, round, "gate-fast.txt", `suite command used: ${liveSuite || "(none)"}\n${gf.stdout}${gf.stderr ? `\n${gf.stderr}` : ""}`, packet));
      checked.push(`${card.id} r${round}: gate-fast mechanical PASS`);
    } else {
      const flagsText = gf ? `${gf.stdout}\n${gf.stderr}` : "gate-fast unavailable (spawn failure or usage error)";
      if (tier === "full") {
        const auditor = agent(`evidence auditor ${card.id} r${round}`, AUDITOR_PERSONA);
        const audit = await retryOn(auditor, 2, (n) =>
          auditor.ask<AuditVerdict>(remind(`Audit the round return's evidence provenance. Return file: ${boardDir}/rounds/${card.id}/r${round}-return.md. The card: ${JSON.stringify(card)}. gate-fast output:\n<<<GF\n${flagsText}\nGF>>>\nBinary AUDIT verdict with quoted issues.`, n)));
        await clerk.ask(clerkGateAsk(card.id, round, "audit", JSON.stringify(audit, null, 2), audit.audit === "PASS"));
        if (audit.audit === "FAIL") {
          await clerk.ask(clerkRunlogAsk(`${card.id} stage=gate AUDIT FAIL — artifact frozen; evidence-only repair next round (r${round + 1})`));
          evidenceOnly = true;
          failed.push({ round, gap: `evidence provenance: ${audit.issues.join("; ").slice(0, 200)}` });
          report(boardRow(card.id, card.title, "in-flight", "gate", round, "AUDIT FAIL — evidence-only repair"), "board");
          continue; // next round = evidence-only
        }
      }
      const gateSeat = agent(`code gate ${card.id} r${round}`, GATE_PERSONA);
      const gate = await retryOn(gateSeat, 2, (n) =>
        gateSeat.ask<GateVerdict>(remind(`Card: ${JSON.stringify(card)}. Round ${round}. Return file: ${boardDir}/rounds/${card.id}/r${round}-return.md. gate-fast output:\n<<<GF\n${flagsText}\nGF>>>${liveSuite ? `\nThe suite command is \`${liveSuite}\` (PLAYBOOK §2) — you run it once from the workspace root yourself.` : "\nNo suite is configured — your evidence-existence and scope checks are the gate."}\nBinary GATE verdict with quoted failing output; per the attribution law, name the owning card or baseline artifact for any out-of-scope attribution.`, n)));
      if (gate.verdict === "PASS") {
        gatePass = true;
        gateNote = "gate agent PASS";
        await clerk.ask(clerkStageAsk(card.id, round, "gate.md", JSON.stringify(gate, null, 2), packet));
        checked.push(`${card.id} r${round}: gate agent PASS`);
      } else {
        // Attribution guard (C5): an out-attribution must NAME its owner —
        // a bare "other-card" claim reclassifies THIS-card (a live close once
        // shipped stray out-of-scope files on exactly this mis-attribution).
        const cited = `${gate.violations.join(" ")} ${gate.checks.join(" ")}`;
        const namesOwner = /\bC-\d{3,}\b/.test(cited);
        const namesBaseline = /baseline/i.test(cited) && /[\/\\]/.test(cited);
        const reclassified = (gate.attribution === "other-card" && !namesOwner) || (gate.attribution === "baseline" && !namesBaseline);
        if (gate.attribution === "this-card" || gate.attribution === "n/a" || reclassified) {
          lastGateFail = true;
          failed.push({ round, gap: `${reclassified ? `attribution "${gate.attribution}" named no owner — reclassified this-card: ` : ""}${gate.violations.join("; ").slice(0, 180) || "gate FAIL"}` });
          await clerk.ask(clerkGateAsk(card.id, round, "gate", JSON.stringify(gate, null, 2), false));
          report(boardRow(card.id, card.title, "in-flight", "gate", round, reclassified ? "gate FAIL (attribution rejected) — repair" : "gate FAIL — repair round next"), "board");
          evidenceOnly = false;
          continue;
        }
        // attributed out WITH a named owner — held-FAIL law: no round consumed
        gatePass = true;
        gateNote = `gate FAIL attributed out (${gate.attribution}) — proceeding with note`;
        await clerk.ask(clerkStageAsk(card.id, round, "gate.md", JSON.stringify(gate, null, 2), packet));
        checked.push(`${card.id} r${round}: gate FAIL attributed out (${gate.attribution}, owner named)`);
        limits.push(`${card.id} r${round}: gate failures attributed to ${gate.attribution} — not this card's round`);
      }
    }

    // ── Close out for trivial cards (the gate is the sole judge) ──
    if (!gatePass) continue;
    if (card.profile === "trivial") {
      closedCount++;
      const oc: CardOutcome = { id: card.id, title: card.title, status: "done", rounds: round, finalScore: -1, largestGap: "", findings: [], panelUsed: false };
      await clerk.ask(clerkCloseAsk(oc, ""));
      report(boardRow(card.id, card.title, "done", "closed", round, gateNote), "board");
      return oc;
    }

    // ── Jury stage ──
    if (juryCalls >= juryBudgetTarget) {
      blockedCount++;
      const oc: CardOutcome = { id: card.id, title: card.title, status: "held-jury-budget", rounds: round, finalScore: -1, largestGap: "jury budget exhausted before judging", findings: [], panelUsed };
      await clerk.ask(clerkCloseAsk(oc, oc.largestGap));
      report(boardRow(card.id, card.title, "blocked", "closed", round, "held: jury budget"), "board");
      return oc;
    }
    juryCalls++;
    report(budgetRow(), "budget");
    // Same-agent juror (C3): retries and format-heals re-ask this one context;
    // the verdict is already computed — a heal is format repair, not re-judging.
    const juror = agent(`juror ${card.id} r${round}`, JUROR_PERSONA);
    let verdict = await retryOn(juror, 2, (n) => juror.ask<Verdict>(remind(packet, n)));
    const shapeOk = (v: Verdict): boolean =>
      (v.verdict === "PASS" || v.verdict === "FAIL") &&
      typeof v.score === "number" && v.score >= 0 && v.score <= 10 &&
      !(v.verdict === "PASS" && v.score < 7) && !(v.verdict === "FAIL" && v.score >= 7) &&
      Array.isArray(v.findings) && Array.isArray(v.evidenceChecked);
    if (!shapeOk(verdict)) {
      log(`${card.id} r${round}: verdict failed the shape pre-check — same-agent heal`);
      verdict = await retryOn(juror, 1, (n) => juror.ask<Verdict>(remind(`${packet}\n\nYour previous reply violated the verdict contract (verdict PASS|FAIL; score 0-10 with PASS ≥ 7 and FAIL < 7; findings and evidenceChecked as arrays). Re-emit the COMPLETE verdict.`, n)));
    }
    await clerk.ask(clerkVerdictAsk(card.id, round, "jury", verdict as unknown as object));
    // Mechanical verdict-contract check on the persisted file
    try {
      const es = await world.run("node", [EVAL_SEAT, "--verdict", `${boardDir}/rounds/${card.id}/r${round}-jury.md`, "--seat", "jury"], { output: { tail: 4096 } });
      if (es.exitCode === 1) {
        log(`${card.id} r${round}: eval-seat VOID — same-agent heal + re-persist`);
        verdict = await retryOn(juror, 1, (n) => juror.ask<Verdict>(remind(`${packet}\n\nYour persisted verdict was mechanically invalidated:\n<<<\n${es.stdout}\n${es.stderr}\n>>>\nRe-emit the COMPLETE verdict honoring the contract exactly.`, n)));
        await clerk.ask(clerkVerdictAsk(card.id, round, "jury2", verdict as unknown as object));
      } else checked.push(`${card.id} r${round}: eval-seat verdict-contract check`);
    } catch { limits.push(`eval-seat unavailable — verdict contract not mechanically checked for ${card.id} r${round}`); }
    collectSpawns(verdict.spawned, `jury@${card.id}.r${round}`);

    // ── Verdict handling ──
    const sameGapTwice = verdict.verdict === "FAIL" && prevVerdict === "FAIL" && Boolean(lastGap) && sameGap(lastGap, verdict.largestGap);
    const contradiction = verdict.verdict === "FAIL" && gateNote === "gate-fast mechanical PASS";
    const flipFlop = prevVerdict !== "" && verdict.verdict !== prevVerdict && Math.abs(verdict.score - prevScore) >= 3;
    const wantsPanel = (sameGapTwice || contradiction || flipFlop || panelPolicy === "closing") && !panelUsed;
    if (verdict.verdict === "PASS" && !wantsPanel) {
      closedCount++;
      const oc: CardOutcome = { id: card.id, title: card.title, status: "done", rounds: round, finalScore: verdict.score, largestGap: "", findings: verdict.findings, panelUsed: false };
      await clerk.ask(clerkCloseAsk(oc, ""));
      report(boardRow(card.id, card.title, "done", "closed", round, `jury PASS ${verdict.score}/10`), "board");
      return oc;
    }
    if (verdict.verdict === "PASS" && wantsPanel && juryCalls + 4 > juryBudgetTarget) {
      // closing-policy PASS without panel budget — close with disclosure
      limits.push(`${card.id}: closing-policy panel skipped — jury budget exhausted`);
      closedCount++;
      const oc: CardOutcome = { id: card.id, title: card.title, status: "done", rounds: round, finalScore: verdict.score, largestGap: "", findings: verdict.findings, panelUsed: false };
      await clerk.ask(clerkCloseAsk(oc, ""));
      report(boardRow(card.id, card.title, "done", "closed", round, `jury PASS ${verdict.score}/10 (panel skipped: budget)`), "board");
      return oc;
    }
    if (wantsPanel && juryCalls + 4 <= juryBudgetTarget) {
      panelUsed = true;
      report(boardRow(card.id, card.title, "panel", "panel", round, `escalation: ${sameGapTwice ? "same gap twice" : contradiction ? "contradicts mechanical gate" : flipFlop ? "verdict flip-flop" : "closing policy"}`), "board");
      const panel = await runPanel(card, round, packet, verdict);
      collectSpawns(panel.spawned, `chief@${card.id}.r${round}`);
      if (panel.verdict === "PASS") {
        closedCount++;
        const oc: CardOutcome = { id: card.id, title: card.title, status: "done", rounds: round, finalScore: -1, largestGap: "", findings: verdict.findings, panelUsed: true };
        await clerk.ask(clerkCloseAsk(oc, ""));
        report(boardRow(card.id, card.title, "done", "closed", round, "panel PASS"), "board");
        return oc;
      }
      failed.push({ round, gap: panel.largestGap });
      lastGap = panel.largestGap;
      prevVerdict = "FAIL";
      prevScore = verdict.score;
      evidenceOnly = false;
      if (round + 1 >= startRound + maxRounds) break; // cap: blocked without another panel
      continue;
    }
    // FAIL
    failed.push({ round, gap: verdict.largestGap });
    lastGap = verdict.largestGap;
    prevVerdict = "FAIL";
    prevScore = verdict.score;
    evidenceOnly = false;
    if (round + 1 >= startRound + maxRounds) break; // round cap — blocked, no panel at cap
  }
  blockedCount++;
  const oc: CardOutcome = { id: card.id, title: card.title, status: "blocked", rounds: roundsSpent, finalScore: prevScore, largestGap: lastGap || "rounds exhausted", findings: [], panelUsed };
  await clerk.ask(clerkCloseAsk(oc, lastGap));
  report(boardRow(card.id, card.title, "blocked", "closed", maxRounds, `blocked: ${lastGap || "rounds exhausted"}`), "board");
  return oc;
}

async function executeRelay(cards: CardSpec[], startAt: Map<string, number>): Promise<CardOutcome[]> {
  phase("Run the judging relay per card");
  const outcomes: CardOutcome[] = [];
  const finished = new Map<string, CardOutcome>();
  const cardsCh = channel<CardSpec>("cards");
  const completions = channel<CardOutcome>("completions");
  const workers: Promise<void>[] = [];
  for (let k = 0; k < Math.max(1, Math.min(maxInFlight, cards.length)); k++) {
    workers.push(future(async () => {
      try {
        for await (const card of cardsCh) {
          let oc: CardOutcome;
          try {
            oc = await runRelay(card, startAt.get(card.id) ?? 1, startAt.has(card.id));
          } catch (e) {
            oc = { id: card.id, title: card.title, status: "blocked", rounds: 0, finalScore: -1, largestGap: `relay error: ${e instanceof Error ? e.message : String(e)}`, findings: [], panelUsed: false };
            try { await clerk.ask(clerkCloseAsk(oc, oc.largestGap)); } catch { /* clerk itself failed — the report carries the state */ }
          }
          completions.send(oc);
        }
      } finally { completions.close(); }
    }));
  }
  const produce = future(async () => {
    const sent = new Set<string>();
    let inflight = 0;
    try {
      const trySend = () => {
        for (const c of cards) {
          if (sent.has(c.id) || finished.has(c.id)) continue;
          if (c.blockedBy.length === 0 || c.blockedBy.every((d) => releases(finished.get(d)?.status))) {
            cardsCh.send(c); sent.add(c.id); inflight++;
            log(`Dispatching ${c.id} — ${c.title}`);
          } else if (c.blockedBy.some((d) => finished.has(d) && !releases(finished.get(d)?.status))) {
            const held: CardOutcome = { id: c.id, title: c.title, status: "held-behind-blocked", rounds: 0, finalScore: -1, largestGap: "held behind a blocked dependency", findings: [], panelUsed: false };
            finished.set(c.id, held);
            completions.send(held);
          }
        }
      };
      const markRestBlocked = () => {
        for (const c of cards) {
          if (!finished.has(c.id)) {
            const oc: CardOutcome = { id: c.id, title: c.title, status: "blocked", rounds: 0, finalScore: -1, largestGap: "unsatisfiable dependencies or cycle", findings: [], panelUsed: false };
            finished.set(c.id, oc);
            completions.send(oc);
          }
        }
      };
      trySend();
      if (finished.size >= cards.length) { /* all decided without dispatch */ }
      else if (inflight === 0) { markRestBlocked(); }
      else {
        for await (const oc of completions) {
          inflight--;
          finished.set(oc.id, oc);
          outcomes.push(oc);
          trySend();
          if (finished.size >= cards.length) break;
          if (inflight <= 0) { markRestBlocked(); break; }
        }
      }
    } finally { cardsCh.close(); }
  });
  await Promise.all([produce, ...workers]);
  // merge: outcomes received via the loop plus cards decided by held/blocked paths
  const merged = cards.map((c) => finished.get(c.id)).filter((o): o is CardOutcome => o !== undefined);
  for (const oc of merged) {
    if (oc.status === "done") closedCount++; else blockedCount++;
    report(boardRow(oc.id, oc.title, oc.status, "closed", oc.rounds, oc.largestGap || oc.status), "board");
  }
  report(budgetRow(), "budget");
  await world.run("node", [BOARD_INDEX, boardDir], { output: "discard" }).catch(() => null);
  return merged;
}

async function materializeSpawns(): Promise<void> {
  if (spawnPool.length === 0) return;
  phase("Materialize agent-proposed cards");
  log(`${spawnPool.length} agent-proposed follow-up(s) to verify and dispose`);
  let existing = (await files.glob(`${boardDir}/cards/*.md`).catch(() => [] as string[]))
    .map((p) => {
      const m = p.match(/C-(\d+)/);
      return m ? `C-${m[1]}` : "";
    })
    .filter(Boolean);
  for (const { entry, source } of spawnPool) {
    if (!spawnOk(entry)) continue;
    const verifier = agent(`spawn verifier (${entry.title.slice(0, 30)})`, VERIFIER_PERSONA);
    const ruling = await retryOn(verifier, 2, (n) =>
      verifier.ask<SpawnRuling>(remind(`Proposed follow-up card (from ${source}):\n${JSON.stringify(entry, null, 2)}\nExisting card scopes: read ${boardDir}/cards/ yourself. Rule create / merge / drop with evidence.`, n)));
    if (ruling.ruling === "create") {
      const id = nextCardId(existing);
      existing.push(id);
      await clerk.ask(`Create a new BACKLOG card from a verified spawn. File ${boardDir}/cards/${id}-spawn.md with frontmatter: id=${id}, title="${entry.title.replace(/"/g, "'")}", status=backlog, stage=brief, profile=${entry.profile}, priority=3, round=0, created-by=${source}, scope=[${entry.scope.join(", ")}], bar=n/a, blocked-by=[], max-rounds=${maxRounds}. Sections: ## Goal (${entry.goal}), ## Bar excerpt (pending — authored before dispatch), ## Comments (rationale: ${entry.rationale}). Append one RUNLOG line: [<timestamp>] SPAWN ${id} from ${source} "${entry.title}" (premise verified: ${ruling.reason.slice(0, 140)}).`);
      report(boardRow(id, entry.title, "backlog", "brief", 0, `spawned from ${source}`), "board");
    } else if (ruling.ruling === "merge") {
      await clerk.ask(`Append a Comment to the card ${ruling.onto} in ${boardDir}/cards/ (find the file whose frontmatter id is ${ruling.onto}): "[<timestamp> spawn] merged from ${source}: ${entry.title} — ${entry.rationale}". Append one RUNLOG line: [<timestamp>] SPAWN from ${source} "${entry.title}" MERGED onto ${ruling.onto}.`);
    } else {
      await clerk.ask(clerkRunlogAsk(`SPAWN from ${source} "${entry.title}" DROPPED — ${ruling.reason.slice(0, 160)}`));
    }
  }
}

async function deliverAndReport(o: {
  status: "READY" | "REPAIR" | "BLOCKED" | "PLANNED";
  contractSummary: string;
  criteria: Criterion[];
  outcomes: CardOutcome[];
  coverageRows: number;
  reviewMode: boolean;
}): Promise<WorkflowReport> {
  phase("Deliver and report");
  // Freeze
  let head = "no git";
  try {
    const h = await world.run("git", ["rev-parse", "HEAD"]);
    if (h.exitCode === 0) head = h.stdout.trim();
  } catch { head = "no git"; }
  checked.push(`freeze: HEAD ${head === "no git" ? "unavailable (not a git repo)" : head}`);
  // Close check (boards with cards)
  let close: CloseCheck | undefined;
  if (!o.reviewMode && o.outcomes.length > 0) {
    const closer = agent("wave-close checker", CLOSER_PERSONA);
    close = await retryOn(closer, 2, (n) =>
      closer.ask<CloseCheck>(remind(`Verify wave close for the board at ${boardDir}/. Coverage denominator rows: ${o.coverageRows}. Read CONFIG.md, cards/, RESIDUALS.md, COVERAGE.csv yourself; run git status for the tree check. Report every checklist item with evidence.`, n)));
  }
  // Handoff + session stop
  await clerk.ask(`Session is ending. Rewrite ${boardDir}/HANDOFF.md as THE resume entrypoint: board state snapshot (every card's status/stage/round — re-read the files), what this run did (one line per outcome), budgets (${juryCalls}/${juryBudgetTarget} jury calls, ${roundsSpent} rounds), and next-session boot order. Then append one RUNLOG line: [<timestamp>] session-stop (mastermind workflow run complete; HANDOFF.md rewritten).`);
  await world.run("node", [BOARD_INDEX, boardDir], { output: "discard" }).catch(() => null);
  // Delivery report
  const findings: WorkflowReport["findings"] = o.outcomes.flatMap((oc) =>
    oc.findings.map((f) => ({ where: f.location, what: f.observation, evidence: `found by ${oc.id} relay (round ${oc.rounds})`, status: "verified" as const, severity: f.severity })));
  for (const m of close?.coverageMissing ?? []) findings.push({ where: m.unit, what: `coverage row unsatisfied: ${m.why}`, evidence: "wave-close checker inventory", status: "unconfirmed", severity: "high" });
  const md = [
    `# Mastermind delivery report`,
    ``,
    `**Status: ${o.status}** — HEAD ${head}`,
    ``,
    `## Contract`,
    o.contractSummary,
    ``,
    `## Acceptance criteria`,
    ...(o.criteria.length ? o.criteria.map((c) => `- ${c.id}: ${c.text} _(evidence: ${c.evidence})_`) : ["- (review/fix mode: see findings)"]),
    ``,
    `## Card outcomes`,
    ...(o.outcomes.length ? o.outcomes.map((oc) => `- ${oc.id} ${oc.title}: **${oc.status}** in ${oc.rounds} round(s)${oc.finalScore >= 0 ? `, score ${oc.finalScore}/10` : ""}${oc.largestGap ? ` — gap: ${oc.largestGap}` : ""}${oc.panelUsed ? " — panel used" : ""}`) : ["- none (light/review mode)"]),
    ``,
    `## Coverage`,
    `${o.coverageRows} required rows; ${close ? `${close.coverageMissing.length} unsatisfied` : "reconciled by the relay (per-card bars)"}.`,
    ...(close?.coverageMissing ?? []).map((m) => `- MISSING ${m.unit}: ${m.why}`),
    ``,
    `## Checks actually run`,
    ...checked.map((c) => `- ${c}`),
    ``,
    `## Limits & disclosures`,
    ...limits.map((c) => `- ${c}`),
    ...(close?.issues ?? []).map((i) => `- ${i}`),
    ``,
    `_Board records: ${boardDir}/ (CONTRACT.md, COVERAGE.csv, cards/, rounds/, RUNLOG.md, HANDOFF.md). Commits are manual — this run never commits._`,
  ].join("\n");
  try {
    await artifact.markdown("report", md, { title: "Mastermind delivery report", description: `${o.status} — ${o.outcomes.filter((x) => x.status === "done").length}/${o.outcomes.length} cards closed on ${head.slice(0, 8)}`, primary: true });
  } catch {
    limits.push("delivery report markdown could not be published — the report is in the run's return value");
    log("delivery report: artifact publish failed — the report is in the run's return value");
  }
  const heldCards = o.outcomes.filter((x) => x.status.startsWith("held")).map((x) => x.id);
  const notCovered = [...limits];
  if (heldCards.length) notCovered.push(`cards held without a verdict: ${heldCards.join(", ")}`);
  if (!effectiveSuite && !o.reviewMode && o.outcomes.length > 0) notCovered.push("no suite configured — verification rests on the seats' own evidence checks");
  if (close?.residualsOpen.length) notCovered.push(`RESIDUALS rows without disposition: ${close.residualsOpen.join(", ")}`);
  return {
    conclusion: `${o.status}: ${o.contractSummary} ${o.outcomes.length ? `${o.outcomes.filter((x) => x.status === "done").length} of ${o.outcomes.length} cards closed` : "light/review engagement"} — ${juryCalls} jury calls, ${roundsSpent} rounds. Board records persisted in ${boardDir}/.`,
    findings,
    verified: checked,
    notCovered,
  };
}

// ═══════════════════════════ Branch dispatch ════════════════════════════════
let result: WorkflowReport;

if (mode === "review") {
  if (!target) { result = blockedReport("mode=review needs a target (the artifact path(s) to review)"); }
  else {
    phase("Review the target");
    log(`Blind review of: ${target}`);
    const packet = `BLIND REVIEW PACKET
You are blind and read-only: judge ONLY this packet; do not edit any file; do not read any board directory.
REVIEW QUESTION (the user's words): ${goal}
TARGET (read it yourself): ${target}
${suite ? `Mechanical check available: run \`${suite}\` from the workspace root and include its result as evidence.` : "No mechanical suite configured — judge from reading and reasoning over the material."}
Report every finding with severity, exact location, the criterion or risk violated, and your observation with the evidence you checked. If the material is clean on your evidence, say so — do not invent criticism.
${HONESTY}`;
    const review = async (): Promise<{ verdicts: Verdict[]; chief?: PanelVerdict }> => {
      if (tier === "full") {
        const seats = ["adversary", "advocate", "auditor"];
        const vs = await Promise.all(seats.map((s) => {
          const seat = agent(`review panel ${s}`, `${JUROR_PERSONA}\n\nSTANCE: ${s === "adversary" ? "prosecution — presume FAIL; it passes only if it survives your attack." : s === "advocate" ? "defense — steelman; still fail any explicitly unmet criterion." : "spec-literalist — every criterion measured MET/PARTIAL/MISSED; any MISSED is a FAIL."}`);
          return retryOn(seat, 2, (n) => seat.ask<Verdict>(remind(packet, n)));
        }));
        const chiefSeat = agent("review chief judge", CHIEF_PERSONA);
        const chief = await retryOn(chiefSeat, 2, (n) =>
          chiefSeat.ask<PanelVerdict>(remind(`Three independent review verdicts on the same material:\n${JSON.stringify(vs, null, 2)}\n\nCondense into the verdict of record (majority rules; tie FAILS; seat-invalidate a verdict citing absent evidence).`, n)));
        return { verdicts: vs, chief };
      }
      const reviewer = agent("reviewer", JUROR_PERSONA);
      return { verdicts: [await retryOn(reviewer, 2, (n) => reviewer.ask<Verdict>(remind(packet, n)))] };
    };
    const { verdicts, chief } = await review();
    const final: PanelVerdict = chief ?? { verdict: verdicts[0].verdict, largestGap: verdicts[0].largestGap, perSeat: [], rationale: "", spawned: [] };
    collectSpawns(final.spawned, "review");
    const allFindings = verdicts.flatMap((v) => v.findings);
    result = await deliverAndReport({
      status: final.verdict === "PASS" ? "READY" : "REPAIR",
      contractSummary: `Blind review of ${target}: ${final.verdict}${final.largestGap ? ` — largest gap: ${final.largestGap}` : ""}.`,
      criteria: [],
      outcomes: [],
      coverageRows: 0,
      reviewMode: true,
    });
    result.findings = allFindings.map((f) => ({ where: f.location, what: f.observation, evidence: "independent review (verified by the seat's own reading)", status: "verified" as const, severity: f.severity }));
    result.verified.push(`${verdicts.length} independent review verdict(s)${chief ? " + chief condensation" : ""}`);
  }
} else if (mode === "resume") {
  if (!hasBoard) { result = blockedReport(`mode=resume but no board exists at ${boardDir}/`); }
  else {
    phase("Reconcile the board");
    const reconciler = agent("board reconciler", RECONCILER_PERSONA);
    const state = await retryOn(reconciler, 2, (n) =>
      reconciler.ask<ReconcileState>(remind(`Reconcile the board at ${boardDir}/ per your role. RUNLOG wins over card frontmatter where they disagree.`, n)));
    await clerk.ask(clerkRunlogAsk(`session-start (resume; reconciler report: ${state.note.slice(0, 140) || "no anomalies"})`));
    const doneIds = new Set(state.cards.filter((c) => ["done", "closed", "dropped"].includes(c.status)).map((c) => c.id));
    const blockedIds = new Set(state.cards.filter((c) => c.status === "blocked").map((c) => c.id));
    const live: CardSpec[] = state.cards
      .filter((c) => ["ready", "in-flight"].includes(c.status))
      .map((c) => ({ id: c.id, title: c.title, goal: c.goal, profile: c.profile, scope: c.scope, bar: c.bar, blockedBy: c.blockedBy, covers: [] }));
    const startAt = new Map<string, number>();
    for (const c of live) {
      const own = state.cards.find((x) => x.id === c.id);
      startAt.set(c.id, (own ? own.round : 0) + 1);
    }
    juryBudgetTarget = panelPolicy === "closing" ? 4 * Math.max(1, live.length) : 2 * Math.max(1, live.length);
    log(`Resume: ${live.length} live card(s), ${doneIds.size} finished, ${blockedIds.size} blocked${state.returnsLanded.length ? `; returns landed for ${state.returnsLanded.join(", ")} — resumed rounds use verify-and-complete briefs` : ""}`);
    let outcomes: CardOutcome[] = [];
    if (live.length > 0) outcomes = await executeRelay(live, startAt);
    await materializeSpawns();
    const anyBlocked = outcomes.some((o) => o.status !== "done");
    result = await deliverAndReport({
      status: outcomes.length === 0 ? "BLOCKED" : anyBlocked ? "REPAIR" : "READY",
      contractSummary: `Resumed board at ${boardDir}/ — ${live.length} live card(s) processed.`,
      criteria: [],
      outcomes,
      coverageRows: 0,
      reviewMode: false,
    });
  }
} else if (mode === "fix") {
  if (!target) { result = blockedReport("mode=fix needs a target (the failure description or repro)"); }
  else {
    const contract = await establishContract(false);
    phase("Understand the failure");
    const analyst = agent("failure analyst", `${ARCHITECT_PERSONA}\n\nYou are analyzing a FAILURE, not planning a feature: reproduce or trace it to concrete material and a violated criterion before proposing any fix.`);
    const fix = await retryOn(analyst, 2, (n) =>
      analyst.ask<FixAnalysis>(remind(`The failure to fix: ${target}\nThe engagement contract: ${JSON.stringify(contract, null, 2)}\nAnalyze the mechanism; the smallest approach; the exact fix scope; the evidence that will prove the fix (a failing repro before, passing after).`, n)));
    await clerk.ask(clerkRunlogAsk(`fix analysis recorded — root cause: ${fix.rootCause.slice(0, 140)}`));
    const plan: Plan = {
      cards: [{ id: nextCardId([]), title: `Fix: ${target.slice(0, 60)}`, goal: `The failure no longer reproduces: ${fix.violatedCriterion}`, profile: "code", scope: fix.scope, bar: `1. The repro case passes.\n2. ${fix.evidenceNeeded}`, blockedBy: [], covers: contract.criteria.map((c) => c.id) }],
      coverage: contract.criteria.map((c) => ({ unit: c.id, card: "C-001", check: c.evidence, environment: "workspace" })),
      sequencing: "single fix card",
      openQuestions: [],
      suiteCommand: await currentSuite(),
    };
    phase("Plan the fix card");
    await clerk.ask(clerkPlanAsk(plan));
    juryBudgetTarget = 2;
    for (const c of plan.cards) report(boardRow(c.id, c.title, "ready", "brief", 0, "fix card"), "board");
    let outcomes: CardOutcome[] = [];
    if ((await approveGate(plan, contract)) === "proceed") outcomes = await executeRelay(plan.cards, new Map());
    await materializeSpawns();
    result = await deliverAndReport({
      status: outcomes.length > 0 && outcomes.every((x) => x.status === "done") ? "READY" : "REPAIR",
      contractSummary: `Fix engagement: ${fix.rootCause}`,
      criteria: contract.criteria,
      outcomes,
      coverageRows: plan.coverage.length,
      reviewMode: false,
    });
  }
} else if (tier === "light") {
  if (!goal) { result = blockedReport("no goal supplied"); }
  else {
    const contract = await establishContract(true);
    phase("Build and check");
    const builder = agent("builder", BUILDER_PERSONA);
    const build = await retryOn(builder, 2, (n) =>
      builder.ask<{ changes: { path: string; summary: string }[]; evidence: { path: string; proves: string }[]; selfCheck: string; deferred: string }>(
        remind(`Objective: ${goal}\nContract: ${JSON.stringify(contract, null, 2)}\nBuild it. Evidence paths must exist on disk when you return. Self-check every criterion before returning.`, n)));
    let checkNote = "";
    const lightSuite = await currentSuite();
    if (lightSuite) {
      const run = await runSuite(lightSuite);
      checkNote = run.exitCode === 0 ? `suite PASS (${lightSuite})` : `suite FAIL (${lightSuite}) — tail: ${run.output.slice(0, 400)}`;
      checked.push(checkNote);
      if (run.exitCode !== 0) {
        const repairer = agent("builder repair", BUILDER_PERSONA);
        await retryOn(repairer, 1, (n) =>
          repairer.ask<{ done: boolean; note: string }>(remind(`The suite failed:\n<<<\n${run.output.slice(-3000)}\n>>>\nFix the minimum needed to pass. Do not run the suite yourself — the script re-runs it. Report what you changed.`, n)));
        const run2 = await runSuite(lightSuite);
        checkNote = run2.exitCode === 0 ? `suite PASS after repair (${lightSuite})` : `suite still FAIL (${lightSuite})`;
        checked.push(checkNote);
      }
    } else {
      const checker = agent("reviewer (light check)", JUROR_PERSONA);
      const review = await retryOn(checker, 2, (n) =>
        checker.ask<Verdict>(remind(`Light-tier independent check. Objective: ${goal}. Read the work the builder produced (evidence paths: ${build.evidence.map((e) => e.path).join(", ") || "inspect the tree"}). Verify each acceptance criterion with your own eyes. ${HONESTY}`, n)));
      checkNote = review.verdict === "PASS" ? `light check PASS (${review.score}/10)` : `light check FAIL — ${review.largestGap}`;
      checked.push(checkNote);
      collectSpawns(review.spawned, "light-review");
    }
    await clerk.ask(clerkRunlogAsk(`light engagement ${checkNote.includes("PASS") ? "READY" : "REPAIR"} — ${checkNote.slice(0, 160)}`));
    result = await deliverAndReport({
      status: checkNote.includes("PASS") ? "READY" : "REPAIR",
      contractSummary: contract.summary,
      criteria: contract.criteria,
      outcomes: [],
      coverageRows: contract.criteria.length,
      reviewMode: true,
    });
  }
} else {
  // standard / full — the full lifecycle
  if (!goal) { result = blockedReport("no goal supplied"); }
  else {
    const contract = await establishContract(false);
    const plan = await planCards(contract);
    const approval = await approveGate(plan, contract);
    if (approval === "blocked") {
      result = await deliverAndReport({ status: "BLOCKED", contractSummary: `${contract.summary} — the plan was blocked at the approval gate.`, criteria: contract.criteria, outcomes: [], coverageRows: plan.coverage.length, reviewMode: false });
    } else if (mode === "plan") {
      // Plan-only stop (mode=plan): the gate is the terminus. Record the
      // approval, dispatch nothing; execute later with mode=resume.
      await clerk.ask(clerkRunlogAsk("plan approved — plan-only stop (mode=plan); execute later with mode=resume"));
      result = await deliverAndReport({
        status: "PLANNED",
        contractSummary: `${contract.summary} — plan approved and recorded; execution deferred (mode=plan).`,
        criteria: contract.criteria,
        outcomes: [],
        coverageRows: plan.coverage.length,
        reviewMode: false,
      });
    } else {
      let outcomes: CardOutcome[] = [];
      if (plan.cards.length > 0) outcomes = await executeRelay(plan.cards, new Map());
      await materializeSpawns();
      const allDone = outcomes.length > 0 && outcomes.every((x) => x.status === "done");
      const anyBlocked = outcomes.some((x) => x.status === "blocked" || x.status === "held-behind-blocked");
      result = await deliverAndReport({
        status: anyBlocked ? "REPAIR" : allDone ? "READY" : outcomes.length === 0 ? "BLOCKED" : "REPAIR",
        contractSummary: contract.summary,
        criteria: contract.criteria,
        outcomes,
        coverageRows: plan.coverage.length,
        reviewMode: false,
      });
    }
  }
}

return result;