---
name: Waren-Import nur pro Lieferant
description: Erfassungsseite hat KEINE generische Sammel-Dropzone mehr; Import startet ausschliesslich über die Lieferanten-Übersicht («Upload nur für …»).
---

# Waren-Import: nur pro Lieferant (08/2026, Build-Befehl)

- **Regel:** Auf der Erfassungsseite (Oliv+Beaulieu, gleiche Seite) ist die
  Lieferanten-Übersicht das einzige Import-Element. Uploads laufen nur über
  «Upload nur für …» (fail-closed: fremde Dateien werden abgewiesen, nie
  umgeleitet). Neue/unbekannte Lieferanten → «Manuell erfassen» (mit PDF-Upload).
- **Why:** User-Befehl «Import nur noch pro Lieferant»; vorher zwei konkurrierende
  Wege (generische Dropzone + Format-Buttons) — Verwechslungsgefahr, geratene
  Zuordnungen. Es wird NIE geraten.
- **How to apply:** Die drei Import-Boxen (CSV/FS/Profil-PDF) bleiben gemountet
  (Refs!) und zeigen ihre Datei-Auswahl erst NACH einem gerouteten Upload
  (`uploadUiVersteckt`); manuell geöffnet zeigen sie nur Undo/Historie/Analyse.
  Beim Wiedereinführen irgendeiner Sammel-Dropzone diesen Befehl beachten.
