---
name: Abgrenzung → Rechnung umdatieren
description: TP/RB-Abgrenzungen auflösen durch Verschieben der App-Rechnung auf den Leistungsmonat — Move-Sicherheitsmuster im KV ohne CAS.
---

**Regeln:**
- Zielmonat: «RB TP …» im Monat M → M−1; «TP …» → M (Lib waren-abgrenzungen, pure, getestet).
- Rechnung wird VERSCHOBEN, nie kopiert; nur auf Bestätigung, nie automatisch.

**Move über zwei Monats-Blobs (kein CAS, kvSet unterdrückt Fehler):**
- Reihenfolge ZIEL zuerst (Teilfehler ⇒ sichtbares Duplikat statt Datenverlust).
- Read-back-Verifikation nach beiden Writes ist der einzige Erfolgs-Nachweis; try/catch allein ist wertlos.
- Kompensation ebenfalls read-back-verifizieren, sonst meldet ein stiller No-op «wiederhergestellt».
- Undo-Record (typ `umdatierung`) erst NACH verifiziertem Erfolg speichern — Write-ahead mit falschem `nachher` bricht den Undo-Stale-Check.

**Folgepflichten nach dem Move:**
- `bereinigeFibuMatchesFuerMonat` für den Quellmonat (sonst «gematcht»-Leiche auf der entfernten ID) UND sichtbaren `fibuState` sofort neu laden, wenn der Quellmonat gerade angezeigt wird.
- WKQ-Vorschau nur über `relevantNetOf` (nurWarenAnteil + relevantNet) — direktes `computeWarenkostenTotals` auf vollen Rechnungen überzeichnet Misch-Splits.

**Why:** Architect-Review 08/2026 lehnte zwei Runden ab, bis Move + Rollback beidseitig read-back-verifiziert waren.
**How to apply:** Jede Operation, die eine Rechnung zwischen `supplier_invoices_*`-Monats-Blobs bewegt.
