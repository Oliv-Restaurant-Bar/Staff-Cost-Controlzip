---
name: Lange Hintergrundjobs (tsc-Volllauf)
description: Wie lange Typcheck-/Buildläufe überleben — bash-nohup stirbt, Notebook-spawn mit absolutem Node-Pfad funktioniert
---

# Lange Hintergrundjobs (tsc-Volllauf)

**Regel:** `nohup … &` aus dem bash-Tool überlebt das Ende des Tool-Aufrufs NICHT zuverlässig — Prozess und sogar die /tmp-Ausgabedateien waren danach mehrfach weg. Lange Läufe (voller `tsc -p tsconfig.app.json`, dauert Minuten) stattdessen aus dem code_execution-Notebook starten: `spawn('bash',['-c',…],{detached:true,stdio:[…file…]})` + `unref()` — der Notebook-Prozess persistiert zwischen Aufrufen.

**Stolperfallen:**
- Im Notebook-Spawn fehlen `npx` UND `node` im PATH → absoluten Node-Pfad verwenden (via `ps aux | grep node` aus dem laufenden System ermitteln, z. B. `/nix/store/…-nodejs-*/bin/node node_modules/typescript/bin/tsc`).
- `process.env` ist im Notebook undefined — nicht darauf zugreifen.
- Schneller Teil-Gate ohne Volllauf: temporäre `tsconfig.check.json` mit `extends: ./tsconfig.app.json`, `files: [geänderte Dateien]`, `include: []` — läuft in <2 min im Vordergrund; Fehlerausgabe auf eigene Dateien filtern (Legacy-Fehler in Fremddateien ignorieren). Datei danach löschen.

**Anwendung:** Immer wenn ein voller Typcheck/Build als Verifikations-Gate gebraucht wird und einzelne bash-Aufrufe (max 2 min) nicht reichen.
