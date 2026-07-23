# Navigations- und KPI-Seiten-Inventar (Konsolidierung)

Verbindliches Inventar ALLER Dashboard-/KPI-/Übersichtsseiten vor der
Navigations-Konsolidierung. Einstufungen: **bleibt** (Nav-Eintrag bleibt) ·
**Drilldown** (Route bleibt, kein/sekundärer Nav-Eintrag, erreichbar über Links) ·
**integriert** (Inhalt lebt in anderer Seite weiter) · **entfernt** (Route → Redirect).

## KPI-/Dashboard-Seiten

| Route | Seite | Inhalt / Einzigartiges | Rollen-Guard | Einstufung |
|---|---|---|---|---|
| `/` | StartOverview «Executive Cockpit» | Ebene-1-Management-KPIs (16er-Katalog), Heute/Risiken/Datenstand/Aufgaben | Admin (inkl. Gast, read-only); andere Rollen → Dashboard bzw. Personal | **bleibt** — zentrale KPI-Startseite («Start») |
| `/dashboard` | Dashboard | Finanzielle Monatsübersicht (Financial-Metrics-Registry) + Operativer Tagesstand | `canAccessModule('dashboard')` (Admin, Manager) | **Drilldown** — Nav-Eintrag entfernt; erreichbar über StartOverview-Button «Ausführliches Dashboard»; für Manager weiterhin Startroute «/» |
| `/verkauf-dashboard` | VerkaufsDashboard | Nur `product_sales`: Quellen-Aggregation, Top/Flop, WES-Pflege, Excel/PDF-Export | adminOnly + beaulieuAllowed | **Drilldown (sekundär)** — Nav-Eintrag hinter «Mehr» (keine zweite KPI-Startseite in der Hauptleiste); Überschneidung mit `/produkt-analyse` bewusst dokumentiert (andere Datenbasis: product_sales vs. gn_*) |
| `/kennzahlen-bericht` | KennzahlenBericht | Operativer Wochen-/Monatsbericht, PDF-Export; Ebene-2-Ziel für KPIs 12/13/15 | adminOnly + beaulieuAllowed | **Drilldown (sekundär)** — bereits hinter «Mehr»; bleibt (KPI-Katalog-Drilldown, `?monat=`-Allow-List) |
| `/tagesansicht` | Tagesansicht | Tages-Umsatzvergleich Ist/VJ/Budget, einzige Erfassungsfläche Tagesumsätze; Ebene-3-Detail «Umsatz» | Modul `tagesansicht` | **bleibt** — kein Duplikat (Erfassung + Detailebene) |
| `/tages-controlling` | Tages-Controlling | Tages-PK/WES-Controlling (PK Plan/Ist, WES %), Exporte | adminOnly | **Drilldown** — bereits ohne Desktop-Nav-Eintrag (Status quo); mobil gepinnt; wechselseitig mit Tagesansicht verlinkt. KEINE Zusammenlegung mit Tagesansicht: andere Fachdomäne (Kosten vs. Umsatz) |
| `/forecast` | ForecastPlanung | Forecast-Planung (keine KPI-Startseite) | adminOnly + beaulieuAllowed | **bleibt** |

## Gäste-/Reservations-Auswertungen

| Route | Seite | Inhalt | Einstufung |
|---|---|---|---|
| `/gaeste` | Gäste CRM | CRM-Liste (PII) | **bleibt** |
| `/gaeste/auswertung` | Gäste & Reservationen | CRM-/Reservations-Auswertung; Ebene-2-Ziel KPI «Gäste»; Redirect-Ziel von `/foratable-report` | **bleibt (sekundär)** |
| `/gaeste/analyse` | Reservations Analyse | Konsolidierte Analyse (Monat vs. VJ, Wochentag, Saison) | **bleibt (sekundär)** — zentrale Analyse-Seite |
| `/gaeste/wochentag` | Reservationen nach Wochentag | Wochentag-Detail inkl. Saison-Einstellungen + Ferien-Analyse (nur hier) | **Drilldown** — kein Nav-Eintrag (Status quo); neu verlinkt aus `/gaeste/analyse` (vorher verwaist) |
| `/gaeste/vorjahr` | Monat Ist vs. Vorjahr | Monats-VJ-Detail mit Tagesvergleich-Popup | **Drilldown** — kein Nav-Eintrag (Status quo); neu verlinkt aus `/gaeste/analyse` (vorher verwaist) |
| `/gaeste/duplikate` | Gäste Duplikate | Werkzeug, keine KPI-Seite | **bleibt (sekundär)** |
| `/foratable-report` | — | Redirect auf `/gaeste/auswertung` | **entfernt (Redirect, Status quo)** |

## Bereits ohne Nav-Eintrag (Status quo, unverändert)

`/reporting`, `/import-cockpit` (Header-Link im Import-Center), `/analyse`
(Soll-Ist), `/erfolgsrechnung`-Unterflächen, `/umsatzabstimmung?year=`-Deep-Links.

## Regeln der Umsetzung

- Entfernte Nav-Einträge behalten ihre Route und bleiben über bestehende Links
  erreichbar (kein toter Link): `/dashboard` ← StartOverview; `/gaeste/wochentag`
  + `/gaeste/vorjahr` ← Reservations Analyse.
- Rollen-Guards werden NICHT angefasst (weder verbreitert noch verengt).
- Keine KPI-Berechnung wird dupliziert oder verschoben: Dashboard-Finanzkarten
  bleiben Registry-basiert; KPI-Katalog-Drilldown-Routen (`kpi-catalog.ts`,
  `monat-param.ts`-Allow-List) bleiben unverändert gültig.
- Mobile Bottom-Nav (PINNED_PATHS) bleibt unverändert.
