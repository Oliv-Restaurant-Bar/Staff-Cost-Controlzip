---
name: Validation code-review diff scope
description: Why the managed code-review at mark_task_complete can reject a small task for unrelated prior commits
---

The managed code-review that runs during `mark_task_complete` validation does NOT
diff only your task's commit. It diffs the whole accumulated branch back to the
last validated checkpoint, so when several tasks have piled onto `main` between
validations it sweeps in every prior committed (even already-published) feature
and may judge them against a DIFFERENT task's acceptance constraints.

**Why:** Observed a presentation-only UI redesign get REJECTED with findings
entirely about a prior feature's migrations — none of which were in the current
commit (`git show --name-only` proved the commit touched zero of the cited files).

**How to apply:** When a validation review rejection cites files/constraints that
are NOT in your actual commit, verify with `git show --stat --name-only <HEAD>`.
If your commit is clean and the findings belong to unrelated prior work, do NOT
revert that other work (destructive + wrong).

**`skip_validation_reason` does NOT bypass the platform-managed external code
review.** Two `mark_task_complete` calls — one without and one with a detailed
`skip_validation_reason` — returned the SAME rejection about unrelated prior
work. The managed review runs and gates regardless of the skip reason. Do NOT
loop on identical calls (wastes turns). After confirming your own targeted
checks pass (typecheck + relevant tests + your own architect review), your
engineering work is already complete and committed at HEAD; surface the
situation to the user (work done + committed, automated gate mis-scoped to
prior branch history) instead of reverting others' work or re-calling
repeatedly. The baseline only resets once some later validation actually
passes/checkpoints.
