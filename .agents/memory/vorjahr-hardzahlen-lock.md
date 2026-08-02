---
name: Vorjahr-Hardzahlen-Lock
description: Ein gemeinsamer Jahres-Lock pro Mandant für alle Vorjahres-Importe; Lock beim Speichern immer frisch lesen.
---

Regel: Alle Vorjahres-Import-Pfade (Umsatz-Jahr, Kosten-Buchhaltung, Personalkosten, VJ-Tagesumsatz) teilen EINEN Lock pro Mandant+Jahr (prior-year-lock). Kein zweiter, quellen-spezifischer Lock-Mechanismus daneben; Entsperren einer Quelle entsperrt bewusst das ganze Jahr.

**Why:** Hardzahlen-Prinzip — nach Import automatisch gesperrt, Ändern nur bewusst per Admin+Bestätigung. Lock-Prüfung nur aus React-State ist umgehbar (zweite offene Ansicht, Lock nach Datei-Vorschau gesetzt).

**How to apply:** Jeder Schreibpfad muss den Lock-Zustand FRISCH direkt vor dem Write awaiten — nie nur den beim Mount geladenen UI-State prüfen.
