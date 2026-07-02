---
name: replit.md editing pitfalls
description: How to safely splice/trim the very long German-text bullets in replit.md
---

**Rule:** Never inline German replit.md bullet text into a bash-heredoc Python script. Write the new bullets to a temp file with the write tool, then splice with a small Python script that reads that file.

**Why:** The bullets mix typographic quotes („…“) with ASCII quotes; hand-typed drafts easily end up with a stray ASCII `"` that terminates the Python string mid-line → confusing `SyntaxError: invalid character '—' (U+2014)` far from the real problem.

**How to apply:** 1) write-tool → `.local/tmp_bullets.md` (one bullet per line), 2) python reads it, asserts the exact start text of the first/last replaced line before splicing, 3) delete temp file. Also: replit.md lines are >2000 chars, so the read tool truncates them — inspect with `sed -n 'X,Yp' | fold -s -w 160`.
