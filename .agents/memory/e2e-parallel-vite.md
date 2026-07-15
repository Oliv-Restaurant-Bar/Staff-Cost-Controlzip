---
name: Parallele E2E-Browser gegen Vite-Dev-Server
description: Zwei gleichzeitige Playwright-Testläufe gegen denselben Vite-Dev-Server liefern leere Seiten (HMR-Websocket 502) — Viewport-Läufe sequenziell fahren.
---

**Regel:** E2E-Testläufe (runTest) gegen den lokalen Vite-Dev-Server NIE parallel starten (kein `Promise.all` über mehrere runTest-Aufrufe).

**Why:** Zwei parallele Browser-Kontexte überlasteten den Dev-Server: die App blieb als leere `#root`-Shell stehen, der Vite-HMR-Websocket lieferte 502/SSL-Fehler, ein Ressourcen-Request 502. Beide Läufe schlugen fehl (failure/unable), obwohl der Server danach sofort wieder normal lief. Sequenzielle Wiederholung derselben Pläne war ohne Änderung grün.

**How to apply:** Responsive-Prüfungen (Desktop/Tablet/Mobile) als separate, nacheinander ausgeführte runTest-Aufrufe planen. In Testpläne den Hinweis aufnehmen «falls die Seite leer bleibt, einmal neu laden». Bei leerer Seite zuerst Workflow-Logs prüfen statt Code zu verdächtigen.
