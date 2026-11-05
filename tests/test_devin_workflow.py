"""Offline synthetic-seat tests. No cloud sessions or API calls."""
import asyncio
import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("mastermind_workflow", ROOT / "skills/mastermind/workflow.py")
workflow = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(workflow)


class AgentFailure(Exception):
    pass


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name) / "repo"
        self.repo.mkdir()
        self.git("init", "-q")
        (self.repo / "app.py").write_text("old\n")
        self.git("add", "app.py")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture")
        self.board = self.repo / "mastermind"
        workflow.CONFIG = {"repo_path": str(self.repo), "repo": "github.com/example/fixture",
                           "commit": self.git("rev-parse", "HEAD").strip(), "goal": "Replace old with new",
                           "suite": 'python3 -c "from pathlib import Path; assert Path(\'app.py\').read_text() == \'new\\n\'"',
                           "tier": "standard", "mode": "plan", "max_rounds": 3}
        self.calls = []
        self.questions = []
        self.covered = ["U1"]
        self.fail_jury = False
        self.fail_panel = False
        self.fail_agent = None
        self.return_path = "app.py"
        self.interrupt = False
        workflow.WorkflowAgentError = AgentFailure
        workflow.log = lambda message: None

        async def register(meta):
            self.assertEqual(meta["subscribe"], "none")
            self.assertTrue(all(p["subscribe"] == "none" for p in meta["phases"]))

        async def agent(prompt, **kwargs):
            phase = kwargs["phase"]
            self.calls.append((phase, prompt))
            self.assertNotIn("vm_mode", kwargs)
            if phase == self.fail_agent:
                raise AgentFailure(phase)
            if phase == "contract":
                return {"summary": "Replace fixture text", "criteria": [{"id": "AC-1", "text": "new", "evidence": "suite"}],
                        "decisions": [], "risks": [], "exclusions": [], "open_questions": self.questions}
            if phase == "plan":
                return {"cards": [{"id": "C-001", "title": "Replace old", "goal": "new is stored", "scope": ["app.py"],
                                   "bar": "File contains new and suite passes", "covers": ["AC-1"], "blocked_by": []}],
                        "coverage": [{"unit": "U1", "card": "C-001", "requirement": "AC-1", "check": "suite", "environment": "Linux"}],
                        "open_questions": []}
            if phase == "implement":
                self.assertTrue((self.board / "rounds/C-001/r1-brief.md").exists())
                return {"files": [{"path": self.return_path, "content": "new\n"}],
                        "evidence": [{"name": "test.txt", "content": "Synthetic child test result", "proves": "fixture check"}],
                        "deferred": "None", "blockers": "None", "spawned": []}
            if phase == "audit":
                return {"verdict": "PASS", "issues": []}
            if phase in ("jury", "panel"):
                if self.interrupt:
                    self.interrupt = False
                    raise RuntimeError("Synthetic controller interruption")
                self.assertTrue((self.board / "rounds/C-001/r1-return.md").exists())
                self.assertTrue((self.board / "rounds/C-001/r1-jury-brief.md").exists())
                self.assertNotIn("correction_target", prompt)
                fail = self.fail_jury if phase == "jury" else self.fail_panel
                return {"verdict": "FAIL" if fail else "PASS", "score": 4 if fail else 9,
                        "largest_gap": "Synthetic bar gap" if fail else "", "evidence_checked": ["app.py"], "covered_units": self.covered}
            if phase == "chief":
                return {"verdict": "FAIL" if self.fail_panel else "PASS", "reason": "Panel majority"}
            if phase == "close":
                return {"issues": [], "checked": ["fixture suite"], "not_checked": []}
            raise AssertionError(phase)

        workflow.register_workflow = register
        workflow.agent = agent

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.repo), *args], text=True)

    def run_workflow(self):
        asyncio.run(workflow.main())

    def approve(self):
        self.run_workflow()
        workflow.CONFIG.update(mode="execute", approved_plan_sha256=workflow.read(self.board / "approval.json")["digest"])

    def test_planning_stops_before_writes_and_execution_requires_digest(self):
        self.approve()
        self.assertEqual([phase for phase, _ in self.calls], ["contract", "plan"])
        self.assertEqual((self.repo / "app.py").read_text(), "old\n")
        workflow.CONFIG["goal"] = "different"
        with self.assertRaisesRegex(ValueError, "approval"):
            self.run_workflow()

    def test_relay_finishes_without_committing_and_resume_skips_done(self):
        self.approve()
        self.run_workflow()
        self.assertTrue((self.board / "REPORT.md").read_text().startswith("# READY"))
        self.assertEqual((self.repo / "app.py").read_text(), "new\n")
        self.assertEqual(self.git("rev-parse", "HEAD").strip(), workflow.CONFIG["commit"])
        calls = len([p for p, _ in self.calls if p == "implement"])
        workflow.CONFIG["mode"] = "resume"
        self.run_workflow()
        self.assertEqual(len([p for p, _ in self.calls if p == "implement"]), calls)

    def test_full_tier_audit_panel_and_chief(self):
        workflow.CONFIG["tier"] = "full"
        self.approve()
        self.run_workflow()
        phases = [p for p, _ in self.calls]
        self.assertEqual(phases.count("panel"), 3)
        self.assertIn("audit", phases)
        self.assertIn("chief", phases)
        self.assertTrue((self.board / "REPORT.md").read_text().startswith("# READY"))

    def test_standard_escalates_gate_jury_contradiction(self):
        self.fail_jury = True
        self.approve()
        self.run_workflow()
        self.assertEqual(len([p for p, _ in self.calls if p == "panel"]), 3)
        self.assertTrue((self.board / "REPORT.md").read_text().startswith("# READY"))

    def test_missing_coverage_never_ready(self):
        self.covered = []
        self.approve()
        self.run_workflow()
        self.assertTrue((self.board / "REPORT.md").read_text().startswith("# REPAIR"))
        self.assertIn("U1", (self.board / "RESIDUALS.md").read_text())

    def test_open_question_blocks_before_planner(self):
        self.questions = ["Which behavior?"]
        self.run_workflow()
        self.assertEqual([p for p, _ in self.calls], ["contract"])
        self.assertIn("BLOCKED", (self.board / "HANDOFF.md").read_text())

    def test_out_of_scope_bundle_is_not_applied(self):
        self.return_path = "stray.py"
        self.approve()
        self.run_workflow()
        self.assertFalse((self.repo / "stray.py").exists())
        self.assertEqual((self.repo / "app.py").read_text(), "old\n")
        self.assertTrue((self.board / "REPORT.md").read_text().startswith("# BLOCKED"))

    def test_user_edit_blocks_resume_without_overwrite(self):
        self.approve()
        self.run_workflow()
        (self.repo / "app.py").write_text("user work\n")
        with self.assertRaisesRegex(ValueError, "Tree changed"):
            self.run_workflow()
        self.assertEqual((self.repo / "app.py").read_text(), "user work\n")

    def test_interrupted_judgment_resumes_landed_return(self):
        self.approve()
        self.interrupt = True
        with self.assertRaisesRegex(RuntimeError, "interruption"):
            self.run_workflow()
        self.run_workflow()
        self.assertEqual(len([p for p, _ in self.calls if p == "implement"]), 1)
        self.assertTrue((self.board / "REPORT.md").read_text().startswith("# READY"))

    def test_failed_agent_blocks_and_no_jury_runs(self):
        self.fail_agent = "implement"
        self.approve()
        self.run_workflow()
        self.assertNotIn("jury", [p for p, _ in self.calls])
        self.assertTrue((self.board / "REPORT.md").read_text().startswith("# BLOCKED"))

    def test_paths_lock_and_verdict_contracts(self):
        for bad in (".", "./app.py", "a//b", "../escape", "/absolute", ".git/config", "a\\b", "a\nb"):
            with self.assertRaises(ValueError):
                workflow.safe_path(self.repo, bad)
        with workflow.board_lock(self.board):
            with self.assertRaises(RuntimeError):
                with workflow.board_lock(self.board):
                    pass
        self.assertFalse(workflow.valid_verdict({"verdict": "PASS", "score": 4, "largest_gap": "", "evidence_checked": ["x"]}))
        (self.repo / "linked").symlink_to(self.repo / "app.py")
        with self.assertRaises(ValueError):
            workflow.safe_path(self.repo, "linked")

    def test_reject_unknown_mode_and_dirty_initial_tree(self):
        workflow.CONFIG["mode"] = "review"
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            self.run_workflow()
        workflow.CONFIG["mode"] = "plan"
        (self.repo / "app.py").write_text("user work")
        with self.assertRaisesRegex(ValueError, "clean tree"):
            self.run_workflow()

    def test_refuses_to_initialize_over_existing_unrelated_directory(self):
        self.board.mkdir()
        (self.board / "PLAYBOOK.md").write_text("user-owned content")
        with self.assertRaisesRegex(ValueError, "unrelated"):
            self.run_workflow()
        self.assertEqual((self.board / "PLAYBOOK.md").read_text(), "user-owned content")


if __name__ == "__main__":
    unittest.main()
