---
name: Warenrechnungen PDF-Erkennung & FIBU-Abgleich
description: PDF-Erkennung (pdfjs+tesseract lazy), Alias-Lernen nur mit Opt-in, Journal nicht mandanten-präfixiert → Oliv-only-Gate
---

- **Journal-Mandanten-Gate**: `sage_journal_v1_{y}_{m}` (reporting-store) ist NICHT tenant-präfixiert; alle Importe stammen aus der Oliv-Buchhaltung. Jede lieferantengenaue FIBU-Auswertung muss `journalVerfuegbarFuerTenant()` (waren-abgleich.ts) respektieren — andere Mandanten IMMER degradiert (nur Total vs. computePLForMonth total_cogs). **Why:** sonst erscheinen Oliv-Buchungen als Beaulieu-Daten (Cross-Tenant-Leak, Review-Fail). **How to apply:** Beim Migrieren auf tenant-präfixierte Journal-Keys das Gate durch echtes Tenant-Scoping ersetzen.
- **Alias-Lernen nur mit expliziter Zustimmung**: erkannte Roh-Schreibweise (erste Textzeile) kann Adress-/Kopfzeile sein; automatisches Speichern vergiftet künftige Auto-Matches dauerhaft. Checkbox default UNCHECKED, Reset pro PDF.
- **Lieferanten-Volltext-Matching** (`findSupplierInText`): Kern-Tokens ohne Rechtsformen (STOP_TOKENS), Ein-Token-Namen < 4 Zeichen nie matchen, bei Gleichstand kein Match (mehrdeutig = unzugeordnet).
- OCR: tesseract.js lazy-import nur wenn pdfjs-Text < 40 Zeichen (Scan); Fehler → `ocrFehler`, nie throw — UI fällt auf manuelle Erfassung zurück, PDF bleibt Beleg.
- `page.render({ canvasContext, viewport })` — kein `canvas`-Property (pdfjs-Typen).
