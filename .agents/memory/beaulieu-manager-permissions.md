---
name: Beaulieu-Geschäftsführer Rechte
description: Dauerhafte Berechtigungsgrenze für die Rolle beaulieu_manager.
---

`beaulieu_manager` ist für den Beaulieu-Mandanten eine nahezu administrative
**operative** Rolle: Cockpit und Cockpit-Budget, Umsatz/Tagesabschlüsse,
Personal, Waren/Produkte/OP-Liste sowie Gäste/Reservationen/Rezensionen sind
erlaubt.

Ausdrücklich ausgeschlossen bleiben der komplette Bereich Finanzen (inklusive
Budget, Erfolgsrechnung, Forecast und Kennzahlen-Bericht), sämtliche
Cockpit-PDF-/Excel-Exporte und Admin-/Systemverwaltung wie Benutzerrechte oder
Mandanteneinstellungen. Die Rolle bleibt strikt auf Beaulieu gebunden.

**Why:** Die Geschäftsführung benötigt operative Handlungsfähigkeit und PII-
Zugriff im eigenen Betrieb, soll aber keine Finanzberichte exportieren und
keine systemweiten Einstellungen oder Benutzerrechte verändern können.

**How to apply:** Neue Flächen über schmale Fähigkeiten einordnen, nicht breite
Admin-Flags aufweiten. Finanz- und Exportaktionen brauchen neben ausgeblendeter
UI auch Route-/Server-Gates; serverseitige Prüfung muss fail-closed sein.