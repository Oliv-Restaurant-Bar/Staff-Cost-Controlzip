---
name: Waren-Ignore-Liste (Privatbezug)
description: Rechnungen dauerhaft aus Warenkosten/WKQ/FIBU ausklammern — import-feste Fence, Lieferanten-Token-Match, Lese-Selbstheilung.
---

# Ignore-Liste (Privatbezug) für Warenrechnungen

**Regeln:**
- KV `waren_ignorierte_rechnungen_v1` (tenantKey), Schlüssel = `normRef(reference)`; Record trägt Snapshot (`entry`) für «wieder aktivieren». Markieren LÖSCHT den Eintrag aus dem Monats-Blob (zählt damit nirgends), reversibel via Snapshot.
- Import-Fence sitzt in den ZWEI zentralen Schreibern `saveInvoiceEntry` + `saveMonthInvoices` (und im Undo-Restore) — jeder Import-Pfad läuft da durch. Liste wird bei JEDEM Schreibvorgang FRISCH gelesen (kein Cache: nur pro Tab invalidierbar → Cross-Tab-Staleness).
- Fence matcht Nummer UND Lieferant per Token-Teilmengen-Vergleich (nie Substring): TG-Markt-Barbezüge haben KURZE Belegnummern (z.B. «58»), die sonst fremde Rechnungen blockieren. Leerer eingehender Lieferant matcht nie.
- Konzern-Familie Transgourmet↔Prodega zählt als EIN Lieferant (wie kreditoren-abgleich): Liste trägt «Transgourmet», der CSV-Import leitet aus Markt «Bern» aber «Prodega» ab — ohne Familien-Match passieren die Barbezüge die Fence.
- Import-VORSCHAUEN müssen die Liste zusätzlich selbst prüfen (istRechnungIgnoriert auf frisch geladener Liste): sonst erscheinen ignorierte Rechnungen angehakt und werden mitgezählt, obwohl die Schreib-Fence sie später still verwirft. Anzeige in eigenem ausgegrautem Block, nie in Anzahl/Summe.
- KV ohne CAS ⇒ check-then-write-Fenster bleibt (bekannte App-Grenze). Gegenmittel: Lese-Selbstheilung `filtereIgnorierteRechnungen` beim Seiten-Load + Repair-Write.
- Reaktivierung bestätigt Persistenz (Monat nachlesen, sonst werfen).

**Why:** Private Markt-Barbezüge (TG bern 58/59/215, 07/2026 Oliv) sollen nie in WKQ/FIBU-Abgleich zählen und bei Re-Importen nie wiederkommen.

**How to apply:** Neue Import-Pfade müssen über saveInvoiceEntry/saveMonthInvoices schreiben, nie direkt kvSet auf `supplier_invoices_*` — sonst umgehen sie die Fence.
