---
name: Z-Bericht-Inbox Auto-Import
description: Auto-Import der per Webhook eingegangenen Z-Bericht-PDFs — Claim-Konzept, Leitplanken, Fehlerpfade
---

# Z-Bericht-Inbox Auto-Import (Browser, Stufe 1)

- Eingang: n8n → Edge Function gastronovi-inbound → Bucket zbericht-inbox + Tabelle zbericht_inbox (pending). Parsing bleibt im Browser (GastronoviZBerichtPage): Auto-Lauf beim Seitenöffnen + Button, über den bestehenden Weg parseGnZBerichtPdf → saveGnImport.
- **Cross-Tab-Race:** zwei offene Tabs dürfen nie beide speichern. Lösung: atomarer Claim (bedingtes UPDATE pending→processing + claimed_at, rows-affected=1 gewinnt), verwaiste Claims nach 10 Min. re-claimbar (dasselbe Prädikat in UI-Filter UND DB-Update halten!). Backstop: partieller UNIQUE INDEX gn_imports(restaurant_id, checksum) WHERE status='active' — zweiter Insert scheitert hart.
- **Leitplanken:** nur eindeutige TAGES-Importe (periodFrom===periodTo) automatisch; Checksummen-Duplikat ⇒ Inbox-Zeile imported mit existingId (nie doppelt); Zeitraum-Überschneidung ⇒ status 'error' (Auto ersetzt NIE bestehende Imports — manuelle Wizard-Entscheidung); kein Textlayer/leeres Parse ⇒ 'error' mit Grund.
- **Fehlerpfade:** terminale Datei-Probleme ⇒ 'error' (kein Auto-Retry, manuelle Prüfung); transiente Fehler (Download, Status-Update) ⇒ Claim released, bleibt pending für den nächsten Lauf. Ein PDF blockiert nie den Batch.
- Tagesabschluss-Schutz: nach Auto-Import denselben Konfliktdialog wie beim manuellen Import ausführen (manuelle Korrekturen nie still überschreiben).
- **Why:** Review-FAIL wegen Doppel-Save-Race zweier Tabs; status-gefilterte Updates NACH dem Save reichen nicht — der Claim muss VOR Download/Parse/Save stehen.

## Voll-Tages-Unique + CAS-Aktivierung + Leser-SSOT (Aug 2026)
- Partieller UNIQUE-Index `gn_imports_tenant_fullday_active_uniq` (restaurant_id, period_from; nur active, period_from=period_to, cost_center leer) — live angewendet; verhindert zwei aktive Voll-Tagesberichte hart.
- saveGnImport: INSERT mit status='pending', Aktivierung (pending→active, .select-CAS) als LETZTER Schritt; scheitert sie → Rollback (replaced reaktivieren, neuen deleted) + «Überschneidung … manuell prüfen». Leser filtern active — pending ist unsichtbar.
- Tagesimport-Auswahl SSOT `waehleAktiveTagesImporte`: Voll-Tagesbericht (cc leer) exklusiv-jüngster, sonst jüngster je Kostenstelle (Summe über cc erlaubt). NUTZEN: loadGnDayClosingsForMonth, loadGnPaymentMethodsForMonth, loadGnDailyGrossRevenue — nie direkt alle aktiven Importe summieren.
