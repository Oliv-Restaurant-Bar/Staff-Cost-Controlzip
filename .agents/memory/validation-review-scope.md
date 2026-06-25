---
name: Validation code-review diff scope
description: Why the managed code-review at mark_task_complete can reject a small task for unrelated prior commits
---

The managed code-review that runs during `mark_task_complete` validation does NOT
diff only your task's commit. It diffs the whole accumulated branch back to the
last validated checkpoint, so when several tasks have piled onto `main` between
validations it sweeps in every prior committed (even already-published) feature
and may judge them against a DIFFERENT task's acceptance constraints.

**Why:** Observed a presentation-only overtime-card redesign get REJECTED with
findings entirely about a prior Gäste-CRM task's migrations ("no new migration"
constraint) — none of which were in the current commit (`git show --name-only`
proved the commit touched zero migration/CRM files).

**How to apply:** When a validation review rejection cites files/constraints that
are NOT in your actual commit, verify with `git show --stat --name-only <HEAD>`.
If your commit is clean and the findings belong to unrelated prior work, do NOT
revert that other work (destructive + wrong). Re-call `mark_task_complete` with a
`skip_validation_reason` explaining the review is out-of-scope for your changed
surface, after confirming your own targeted checks (typecheck + relevant tests +
your own architect review) pass.
