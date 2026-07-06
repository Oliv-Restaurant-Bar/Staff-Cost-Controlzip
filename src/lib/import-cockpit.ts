/**
 * import-cockpit.ts — Reine Deskriptor- + Statuslogik für das Import-Cockpit.
 * =========================================================================
 * KEIN React / Supabase / DOM hier (nur `import type` + date-fns). Dieses Modul
 * ist die Single Source of Truth für:
 *   - WELCHE Datenquellen das Cockpit überwacht (COCKPIT_SOURCES)
 *   - WIE oft jede Quelle erwartet wird (interval) und WOHIN verlinkt wird (route)
 *   - WIE ein roher Frische-Signal (letztes Datendatum + letzter Importlauf) auf
 *     einen Anzeige-Status abgebildet wird (computeSourceStatus)
 *   - WIE Datenlücken erkannt (findMissingDays), KPIs summiert (summarizeCockpit)
 *     und die Checkliste gruppiert werden (groupChecklist)
 *
 * READ-ONLY-POSTUR: Dieses Modul (und das gesamte Cockpit) verändert KEINE
 * Importprozesse, keine Business-Logik, keine Tabellen. Es liest nur bestehende
 * Signale und stellt sie dar. Es werden NIE Zeitstempel erfunden: fehlt ein
 * Signal, ist der Status `never` (nie importiert) bzw. `uncheckable` (keine
 * automatisch ableitbare Historie).
 */

import {
  parseISO,
  endOfMonth,
  addDays,
  addMonths,
  addYears,
  differenceInCalendarDays,
  format,
} from 'date-fns';

// ─── Grundtypen ────────────────────────────────────────────────────────────────

export type ImportInterval = 'daily' | 'weekly' | 'monthly' | 'yearly';

/**
 * Anzeige-Status einer Datenquelle.
 * - current      → grün:  Import aktuell
 * - due_soon     → gelb:  bald fällig ODER einzelne Tage fehlen (Datenlücke)
 * - overdue      → rot:   überfällig ODER letzter Import fehlgeschlagen
 * - never        → grau:  noch nie importiert (Quelle prüfbar, aber leer)
 * - uncheckable  → grau:  keine automatisch ableitbare Historie / nicht eingerichtet
 */
export type CockpitStatus = 'current' | 'due_soon' | 'overdue' | 'never' | 'uncheckable';

/** Checklisten-Zustand eines Punkts (abgeleitet aus dem Status). */
export type ChecklistState = 'done' | 'open' | 'overdue' | 'unknown';

export type CockpitSourceId =
  | 'reservationen'
  | 'gaeste_crm'
  | 'zbericht'
  | 'tagesumsatz'
  | 'produktverkaeufe'
  | 'mirus'
  | 'forecast'
  | 'personalkosten'
  | 'dienstplanung'
  | 'warenrechnungen'
  | 'budgetkontrolle'
  | 'monatsabschluss'
  | 'inventur'
  | 'jahresbudget'
  | 'vorjahresvergleich';

/**
 * Fachliche Kategorie einer Datenquelle (Domänen-Achse für Filter/Gruppierung).
 * Unabhängig von der `importType`-Achse (WIE die Daten hereinkommen).
 */
export type CockpitCategory =
  | 'reservationen_gaeste'
  | 'umsatz_gastronovi'
  | 'produkte'
  | 'personal'
  | 'waren_rechnungen'
  | 'finanzen_budget'
  | 'planung_kontrolle';

/**
 * Art des Imports (WIE die Daten hereinkommen) — reine Anzeige/Filter-Achse,
 * KEINE Prozesslogik. `not_configured` = es existiert (noch) kein eingerichteter
 * Import-/Erfassungsweg.
 */
export type CockpitImportType =
  | 'file_upload' // Datei-Upload
  | 'manual_entry' // Manuelle Eingabe
  | 'control' // Kontrolle
  | 'system' // Automatisch / Systemdaten
  | 'not_configured'; // Nicht eingerichtet

/** Statischer Deskriptor einer überwachten Datenquelle. */
export interface CockpitSourceDef {
  id: CockpitSourceId;
  /** Anzeigename der Datenquelle. */
  label: string;
  /** Bereich / Modul (Kontext-Spalte). */
  module: string;
  /** Fachliche Kategorie (Filter/Gruppierung). */
  category: CockpitCategory;
  /** Art des Imports (Filter + Anzeige). */
  importType: CockpitImportType;
  /** „Was hochladen?" — was muss hochgeladen/erfasst/geprüft werden. */
  uploadLabel: string;
  /** Quelle der Datei/Daten (z. B. „Export aus Foratable → Reservationen"). */
  sourceHint?: string;
  /** Beispiel-Dateiname oder Format (nur bei Datei-Uploads sinnvoll). */
  exampleFormat?: string;
  /** Erwartetes Import-/Kontrollintervall. */
  interval: ImportInterval;
  /** Kurzbeschreibung (Detail-Drawer). */
  description: string;
  /** Aufgabentext in der Checklisten-Ansicht. */
  checklistLabel: string;
  /** Zielroute für „Aktion" / „Zur Importseite" (falls vorhanden). */
  route?: string;
  /** Sprechendes Aktions-Label für Button/Link (z. B. „Zur Gastronovi-Importseite"). */
  actionLabel?: string;
  /**
   * true → es gibt ein automatisch ableitbares Frische-Signal (Datenlücken/
   * Freshness werden berechnet). false → reine Kontroll-/Erinnerungsaufgabe ohne
   * ableitbares Signal → Status `uncheckable`.
   */
  checkable: boolean;
  /** true → tägliche Quelle, für die Datenlücken (fehlende Tage) sinnvoll sind. */
  detectGaps?: boolean;
  /**
   * true → Signal ist mandantenübergreifend (z. B. `product_sales` ohne
   * `restaurant_id`); die UI kennzeichnet das, damit die Frische nicht
   * fälschlich als mandantenspezifisch gelesen wird.
   */
  tenantNeutral?: boolean;
}

/** Rohes Frische-Signal einer Quelle (vom read-only DB-Aggregator gefüllt). */
export interface CockpitSignal {
  /**
   * Frische-treibendes Datum (yyyy-MM-dd | yyyy-MM | yyyy) oder null. Fehlt es,
   * fällt `computeSourceStatus` auf das Datum des letzten Importlaufs zurück.
   */
  latestDataDate: string | null;
  /** Anzeige „Daten von" (frühester Datenstand). */
  dataFrom?: string | null;
  /** Anzeige „Daten bis" (spätester Datenstand; Default = latestDataDate). */
  dataUntil?: string | null;
  /** Anzahl Datensätze/Tage, falls verfügbar. */
  recordCount?: number | null;
  /** Letzter protokollierter Importlauf (nur wenn eine Historie existiert). */
  lastImport?: { at: string | null; status: 'success' | 'failed'; by?: string | null } | null;
  /** Abgedeckte Tage (nur für detectGaps-Quellen, Fenster-begrenzt). */
  coveredDates?: string[];
}

/** Ergebnis der Statusberechnung einer Quelle. */
export interface CockpitStatusResult {
  status: CockpitStatus;
  latestDataDate: string | null;
  /** Kalendertage zwischen `now` und dem normalisierten Datenstand (null = kein Datum). */
  daysBehind: number | null;
  /** Nächste erwartete Fälligkeit (yyyy-MM-dd) oder null. */
  nextDue: string | null;
  /** Fehlende Tage im Prüffenster (nur detectGaps-Quellen). */
  missingDays: string[];
  /** true → letzter Import ist fehlgeschlagen. */
  failed: boolean;
  /** Menschenlesbare Begründung. */
  reason: string;
}

/** Zusammengesetzte Zeile (Deskriptor + Signal + berechneter Status). */
export interface CockpitRow {
  def: CockpitSourceDef;
  signal: CockpitSignal;
  result: CockpitStatusResult;
}

// ─── Schwellenwerte ─────────────────────────────────────────────────────────────

interface IntervalThreshold {
  /** ≤ diese Kalendertage „hinter" → current. */
  currentMaxDaysBehind: number;
  /** ≤ diese Kalendertage „hinter" → due_soon, darüber → overdue. */
  dueSoonMaxDaysBehind: number;
}

/**
 * Frische-Schwellen je Intervall (in Kalendertagen). Zentral, damit Tests sie
 * fixieren und spätere Anpassungen einfach bleiben. „yearly" wird separat über
 * den Jahresvergleich behandelt (siehe statusFromDaysBehind).
 */
export const INTERVAL_THRESHOLDS: Record<ImportInterval, IntervalThreshold> = {
  daily: { currentMaxDaysBehind: 1, dueSoonMaxDaysBehind: 3 },
  weekly: { currentMaxDaysBehind: 7, dueSoonMaxDaysBehind: 10 },
  monthly: { currentMaxDaysBehind: 31, dueSoonMaxDaysBehind: 62 },
  yearly: { currentMaxDaysBehind: 365, dueSoonMaxDaysBehind: 400 },
};

/** Fenster (Tage) rückwärts ab dem letzten Datenstand für die Lücken-Prüfung. */
export const GAP_WINDOW_DAYS = 30;

// ─── Deskriptoren ───────────────────────────────────────────────────────────────

/**
 * Alle überwachten Datenquellen in kanonischer Reihenfolge (täglich → jährlich).
 * `checkable: true` = automatisch ableitbares Signal; `checkable: false` = reine
 * Kontroll-/Erinnerungsaufgabe (Status `uncheckable`, in Tabelle UND Checkliste
 * sichtbar, damit die „Nicht prüfbar"-KPI und der „Nur nicht prüfbare"-Filter
 * greifen).
 */
export const COCKPIT_SOURCES: CockpitSourceDef[] = [
  // ── Täglich ──
  {
    id: 'reservationen',
    label: 'Foratable Reservationen',
    module: 'Foratable / Reservationen',
    category: 'reservationen_gaeste',
    importType: 'file_upload',
    uploadLabel: 'Foratable Reservations-CSV',
    sourceHint: 'Export aus Foratable → Reservationen',
    exampleFormat: 'reservationen_export.csv',
    interval: 'daily',
    description:
      'Reservationen aus Foratable. Frische = spätestes Reservationsdatum; letzter Lauf aus der Import-Historie.',
    checklistLabel: 'Reservationen importieren',
    route: '/foratable-import',
    actionLabel: 'Zur Foratable-Importseite',
    checkable: true,
  },
  {
    id: 'gaeste_crm',
    label: 'Foratable Gäste / CRM',
    module: 'Foratable / Gäste-CRM',
    category: 'reservationen_gaeste',
    importType: 'file_upload',
    uploadLabel: 'Foratable Gäste-/Kontakt-CSV',
    sourceHint: 'Export aus Foratable → Gäste/Kontakte',
    exampleFormat: 'gaeste_export.csv',
    interval: 'daily',
    description:
      'Gästeexport für die CRM-Anreicherung. Frische = spätester Gäste-Datenstand; letzter Lauf aus der Import-Historie.',
    checklistLabel: 'Gäste-CRM aktualisieren',
    route: '/gaeste-import',
    actionLabel: 'Zur Foratable-Importseite',
    checkable: true,
  },
  {
    id: 'zbericht',
    label: 'Gastronovi Z-Bericht',
    module: 'Umsatz / Gastronovi',
    category: 'umsatz_gastronovi',
    importType: 'file_upload',
    uploadLabel: 'Gastronovi Z-Bericht CSV/PDF',
    sourceHint: 'Export aus Gastronovi → Z-Bericht',
    exampleFormat: 'z-bericht_2026-07-06.csv / .pdf',
    interval: 'daily',
    description: 'Tages- und Perioden-Z-Berichte (Umsatz) aus Gastronovi. Frische = spätestes Berichtsende.',
    checklistLabel: 'Z-Bericht importieren',
    route: '/gastronovi-import',
    actionLabel: 'Zur Gastronovi-Importseite',
    checkable: true,
  },
  {
    id: 'tagesumsatz',
    label: 'Tagesumsatz',
    module: 'Umsatz / Tagesansicht',
    category: 'umsatz_gastronovi',
    importType: 'manual_entry',
    uploadLabel: 'Tagesumsatz-Import oder Tagesabschluss',
    sourceHint: 'Manuelle Erfassung in der Tagesansicht oder Tagesabschluss',
    interval: 'daily',
    description: 'Erfasste Ist-Tagesumsätze. Frische = spätester Tag mit Umsatz; fehlende Tage werden erkannt.',
    checklistLabel: 'Tagesumsatz erfassen / importieren',
    route: '/tagesansicht',
    actionLabel: 'Zur Tagesansicht',
    checkable: true,
    detectGaps: true,
  },
  {
    id: 'produktverkaeufe',
    label: 'Produktverkäufe',
    module: 'Produkte / Verkauf',
    category: 'produkte',
    importType: 'file_upload',
    uploadLabel: 'Gastronovi Produktverkaufs-CSV',
    sourceHint: 'Export aus Gastronovi → Produktverkauf',
    exampleFormat: 'produktverkauf.csv',
    interval: 'daily',
    description:
      'Artikel-/Produktverkäufe (Gastronovi CSV). Frische = spätestes Verkaufsdatum. Hinweis: Datenquelle ist mandantenübergreifend.',
    checklistLabel: 'Produktverkäufe importieren',
    route: '/sales-upload',
    actionLabel: 'Zur Produktverkauf-Importseite',
    checkable: true,
    tenantNeutral: true,
  },
  {
    id: 'mirus',
    label: 'Mirus Arbeitszeiten',
    module: 'Personal / Ist-Stunden',
    category: 'personal',
    importType: 'file_upload',
    uploadLabel: 'Mirus Arbeitszeitblatt Excel',
    sourceHint: 'Export aus Mirus → Arbeitszeitblatt',
    exampleFormat: 'arbeitszeiten.xls / .xlsx',
    interval: 'daily',
    description: 'Ist-Arbeitszeiten aus Mirus/CSV. Frische = spätester Arbeitszeit-Tag; fehlende Tage werden erkannt.',
    checklistLabel: 'Arbeitszeiten Mirus importieren',
    route: '/import',
    actionLabel: 'Zur Arbeitszeit-Importseite',
    checkable: true,
    detectGaps: true,
  },
  // ── Wöchentlich ──
  {
    id: 'dienstplanung',
    label: 'Dienstplanung Folgewochen',
    module: 'Personal / Dienstplan',
    category: 'personal',
    importType: 'control',
    uploadLabel: 'Kein Upload – Dienstplan prüfen',
    sourceHint: 'Dienstplan im Planer prüfen (kein externer Export)',
    interval: 'weekly',
    description: 'Geplante Schichten. Frische = spätester geplanter Tag (wie weit reicht der Plan in die Zukunft?).',
    checklistLabel: 'Dienstplanung Folgewochen prüfen',
    route: '/schedule-planner',
    actionLabel: 'Zum Dienstplan',
    checkable: true,
  },
  {
    id: 'forecast',
    label: 'Forecast-Kontrolle',
    module: 'Umsatz / Forecast',
    category: 'planung_kontrolle',
    importType: 'manual_entry',
    uploadLabel: 'Kein Upload – Forecast aktualisieren',
    sourceHint: 'Manuelle Pflege im Forecast-Modul',
    interval: 'weekly',
    description: 'Wöchentliche Kontrolle der Umsatz-Forecasts. Reine Kontrollaufgabe ohne automatisches Signal.',
    checklistLabel: 'Forecast aktualisieren',
    route: '/forecast',
    actionLabel: 'Zur Forecast-Seite',
    checkable: false,
  },
  {
    id: 'personalkosten',
    label: 'Personalkosten-Kontrolle',
    module: 'Personal / Controlling',
    category: 'planung_kontrolle',
    importType: 'control',
    uploadLabel: 'Kein Upload – Kontrolle durchführen',
    sourceHint: 'Kontrolle im Personal-Controlling',
    interval: 'weekly',
    description: 'Wöchentliche Kontrolle der Personalkosten. Reine Kontrollaufgabe ohne automatisches Signal.',
    checklistLabel: 'Personalkosten kontrollieren',
    route: '/personal-fix',
    actionLabel: 'Zum Personal-Controlling',
    checkable: false,
  },
  // ── Monatlich ──
  {
    id: 'warenrechnungen',
    label: 'Warenrechnungen',
    module: 'Warenkosten / Rechnungen',
    category: 'waren_rechnungen',
    importType: 'file_upload',
    uploadLabel: 'Lieferantenrechnungen PDF',
    sourceHint: 'PDF-Rechnungen von Lieferanten',
    exampleFormat: 'rechnung_*.pdf',
    interval: 'monthly',
    description: 'Lieferanten-Rechnungen / Warenkosten. Keine automatisch ableitbare Import-Historie vorhanden.',
    checklistLabel: 'Warenrechnungen importieren',
    route: '/warenrechnungen',
    actionLabel: 'Zu den Warenrechnungen',
    checkable: false,
  },
  {
    id: 'monatsabschluss',
    label: 'Monatsabschluss / Kosten',
    module: 'Finanzen / Erfolgsrechnung',
    category: 'finanzen_budget',
    importType: 'control',
    uploadLabel: 'Monatszahlen / Kosten prüfen',
    sourceHint: 'Monatszahlen/Kosten in der Erfolgsrechnung',
    interval: 'monthly',
    description: 'Kontoblätter/Kosten je Monat (Erfolgsrechnung). Frische = spätester Monat mit erfassten Kosten.',
    checklistLabel: 'Monatsabschluss prüfen',
    route: '/erfolgsrechnung',
    actionLabel: 'Zur Erfolgsrechnung',
    checkable: true,
  },
  {
    id: 'budgetkontrolle',
    label: 'Budgetkontrolle',
    module: 'Finanzen / Budget',
    category: 'finanzen_budget',
    importType: 'control',
    uploadLabel: 'Kein Upload – Budget prüfen',
    sourceHint: 'Soll/Ist-Abgleich im Budget-Modul',
    interval: 'monthly',
    description: 'Monatlicher Soll/Ist-Abgleich gegen das Budget. Reine Kontrollaufgabe ohne automatisches Signal.',
    checklistLabel: 'Budgetkontrolle durchführen',
    route: '/budget',
    actionLabel: 'Zum Budget',
    checkable: false,
  },
  {
    id: 'inventur',
    label: 'Inventur / Warenbestand',
    module: 'Warenkosten / Inventur',
    category: 'waren_rechnungen',
    importType: 'not_configured',
    uploadLabel: 'Inventurdatei oder Bestand prüfen',
    sourceHint: 'Inventurdatei oder manuelle Bestandsprüfung',
    exampleFormat: 'inventur.csv / .xlsx',
    interval: 'monthly',
    description: 'Monatliche Inventur / Warenbestand. Optional; keine automatisch ableitbare Historie vorhanden.',
    checklistLabel: 'Inventur / Warenbestand prüfen',
    route: '/wes-analyse',
    actionLabel: 'Zur WES-Analyse',
    checkable: false,
  },
  // ── Jährlich ──
  {
    id: 'jahresbudget',
    label: 'Jahresbudget',
    module: 'Finanzen / Budget',
    category: 'finanzen_budget',
    importType: 'manual_entry',
    uploadLabel: 'Jahresbudget erfassen / prüfen',
    sourceHint: 'Jahresbudget im Budget-Modul erfassen',
    interval: 'yearly',
    description: 'Erfasstes Jahresbudget. Frische = spätestes Budgetjahr, für das Daten hinterlegt sind.',
    checklistLabel: 'Jahresbudget erfassen / prüfen',
    route: '/budget',
    actionLabel: 'Zum Budget',
    checkable: true,
  },
  {
    id: 'vorjahresvergleich',
    label: 'Vorjahresvergleich',
    module: 'Finanzen / Reporting',
    category: 'finanzen_budget',
    importType: 'control',
    uploadLabel: 'Vorjahresdaten prüfen / importieren',
    sourceHint: 'Vorjahres-/Jahresabschlussdaten',
    exampleFormat: 'vorjahr_*.csv',
    interval: 'yearly',
    description: 'Vorjahres-/Jahresabschlussdaten für den P&L-Vergleich. Kontrollaufgabe ohne automatisches Signal.',
    checklistLabel: 'Vorjahresvergleich aktualisieren',
    route: '/import',
    actionLabel: 'Zum Import-Center',
    checkable: false,
  },
];

export function getCockpitSource(id: CockpitSourceId): CockpitSourceDef | undefined {
  return COCKPIT_SOURCES.find((s) => s.id === id);
}

// ─── Datum-Normalisierung ───────────────────────────────────────────────────────

const RE_DAY = /^\d{4}-\d{2}-\d{2}$/;
const RE_MONTH = /^\d{4}-\d{2}$/;
const RE_YEAR = /^\d{4}$/;

/**
 * Normalisiert einen Datenstand (yyyy-MM-dd | yyyy-MM | yyyy) auf ein konkretes
 * Datum: Tag → selber Tag, Monat → Monatsende, Jahr → 31.12. Ungültig → null.
 */
export function normalizeDataDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const v = value.trim();
  if (RE_DAY.test(v)) {
    const d = parseISO(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (RE_MONTH.test(v)) {
    const [y, m] = v.split('-').map(Number);
    return endOfMonth(new Date(y, m - 1, 1));
  }
  if (RE_YEAR.test(v)) {
    return new Date(Number(v), 11, 31);
  }
  const d = parseISO(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ─── Statusberechnung ────────────────────────────────────────────────────────────

function statusFromDaysBehind(
  interval: ImportInterval,
  daysBehind: number,
  latestYear: number,
  nowYear: number,
): CockpitStatus {
  if (interval === 'yearly') {
    if (latestYear >= nowYear) return 'current';
    if (latestYear === nowYear - 1) return 'due_soon';
    return 'overdue';
  }
  const t = INTERVAL_THRESHOLDS[interval];
  if (daysBehind <= t.currentMaxDaysBehind) return 'current';
  if (daysBehind <= t.dueSoonMaxDaysBehind) return 'due_soon';
  return 'overdue';
}

function computeNextDue(interval: ImportInterval, normalized: Date): string {
  let next: Date;
  switch (interval) {
    case 'daily':
      next = addDays(normalized, 1);
      break;
    case 'weekly':
      next = addDays(normalized, 7);
      break;
    case 'monthly':
      next = addMonths(normalized, 1);
      break;
    case 'yearly':
      next = addYears(normalized, 1);
      break;
  }
  return format(next, 'yyyy-MM-dd');
}

/**
 * Bildet ein Frische-Signal auf einen Anzeige-Status ab.
 * Reihenfolge: uncheckable → fehlgeschlagen → kein Datum (never) → Frische +
 * (nur bei detectGaps) Datenlücken-Downgrade. Datenlücken können den Status
 * HÖCHSTENS auf `due_soon` senken, NIE auf `overdue` (Ruhetage/Betriebsferien
 * erzeugen legitime Lücken).
 */
export function computeSourceStatus(
  def: Pick<CockpitSourceDef, 'interval' | 'checkable' | 'detectGaps'>,
  signal: CockpitSignal,
  now: Date = new Date(),
): CockpitStatusResult {
  // 1) Nicht prüfbar (reine Kontrollaufgabe / keine ableitbare Historie).
  if (!def.checkable) {
    return {
      status: 'uncheckable',
      latestDataDate: null,
      daysBehind: null,
      nextDue: null,
      missingDays: [],
      failed: false,
      reason: 'Nicht automatisch prüfbar – manuelle Kontrolle',
    };
  }

  const failed = signal.lastImport?.status === 'failed';
  // Frische-Bezugsdatum: bevorzugt der Datenstand, sonst der letzte Importlauf.
  const refRaw = signal.latestDataDate ?? (signal.lastImport?.at ? signal.lastImport.at.slice(0, 10) : null);
  const normalized = normalizeDataDate(refRaw);

  // 2) Letzter Import fehlgeschlagen → overdue (rot), unabhängig vom Datenstand.
  if (failed) {
    return {
      status: 'overdue',
      latestDataDate: signal.latestDataDate,
      daysBehind: normalized ? differenceInCalendarDays(now, normalized) : null,
      nextDue: null,
      missingDays: [],
      failed: true,
      reason: 'Letzter Import fehlgeschlagen',
    };
  }

  // 3) Kein Datum ableitbar → noch nie importiert.
  if (!normalized) {
    return {
      status: 'never',
      latestDataDate: null,
      daysBehind: null,
      nextDue: null,
      missingDays: [],
      failed: false,
      reason: 'Noch nie importiert',
    };
  }

  const daysBehind = differenceInCalendarDays(now, normalized);
  let status = statusFromDaysBehind(def.interval, daysBehind, normalized.getFullYear(), now.getFullYear());

  // 4) Datenlücken (nur tägliche detectGaps-Quellen) — senken höchstens auf due_soon.
  let missingDays: string[] = [];
  if (def.detectGaps && signal.coveredDates && signal.coveredDates.length > 0) {
    const to = format(normalized, 'yyyy-MM-dd');
    const from = format(addDays(normalized, -GAP_WINDOW_DAYS), 'yyyy-MM-dd');
    missingDays = findMissingDays(signal.coveredDates, from, to);
    if (missingDays.length > 0 && status === 'current') {
      status = 'due_soon';
    }
  }

  const nextDue = computeNextDue(def.interval, normalized);
  const dateLabel = formatCockpitDate(signal.latestDataDate ?? refRaw);
  let reason: string;
  if (missingDays.length > 0) {
    reason = `Datenlücke: ${missingDays.length} fehlende ${missingDays.length === 1 ? 'Tag' : 'Tage'} (Daten bis ${dateLabel})`;
  } else if (status === 'current') {
    reason = `Aktuell – Daten bis ${dateLabel}`;
  } else if (status === 'due_soon') {
    reason = `Bald fällig – Daten bis ${dateLabel}`;
  } else {
    reason = `Überfällig – Daten nur bis ${dateLabel}`;
  }

  return {
    status,
    latestDataDate: signal.latestDataDate ?? refRaw,
    daysBehind,
    nextDue,
    missingDays,
    failed: false,
    reason,
  };
}

/**
 * Findet fehlende Tage ZWISCHEN dem ersten und letzten abgedeckten Tag im
 * Fenster [from, to] (nur „innere" Löcher). Führende/abschliessende Staleness
 * wird bewusst NICHT als Lücke gewertet (dafür ist der Frische-Status zuständig).
 */
export function findMissingDays(covered: string[], from: string, to: string): string[] {
  const set = new Set(covered.filter((d) => RE_DAY.test(d)));
  if (set.size === 0) return [];
  const inRange = [...set].filter((d) => d >= from && d <= to).sort();
  if (inRange.length < 2) return [];
  const start = parseISO(inRange[0]);
  const end = parseISO(inRange[inRange.length - 1]);
  const missing: string[] = [];
  for (let d = addDays(start, 1); d < end; d = addDays(d, 1)) {
    const iso = format(d, 'yyyy-MM-dd');
    if (!set.has(iso)) missing.push(iso);
  }
  return missing;
}

// ─── KPIs ────────────────────────────────────────────────────────────────────────

export interface CockpitKpis {
  current: number;
  dueSoon: number;
  overdue: number;
  never: number;
  uncheckable: number;
  dataGaps: number;
}

/** Zählt die Statusverteilung + Anzahl Quellen mit Datenlücken für die KPI-Karten. */
export function summarizeCockpit(rows: Array<Pick<CockpitRow, 'result'>>): CockpitKpis {
  const kpis: CockpitKpis = { current: 0, dueSoon: 0, overdue: 0, never: 0, uncheckable: 0, dataGaps: 0 };
  for (const { result } of rows) {
    switch (result.status) {
      case 'current':
        kpis.current++;
        break;
      case 'due_soon':
        kpis.dueSoon++;
        break;
      case 'overdue':
        kpis.overdue++;
        break;
      case 'never':
        kpis.never++;
        break;
      case 'uncheckable':
        kpis.uncheckable++;
        break;
    }
    if (result.missingDays.length > 0) kpis.dataGaps++;
  }
  return kpis;
}

// ─── Checkliste ────────────────────────────────────────────────────────────────

export interface ChecklistItem {
  id: CockpitSourceId;
  label: string;
  state: ChecklistState;
  route?: string;
  /** „Was hochladen?" / was ist zu tun (für die Checklisten-Detailzeile). */
  uploadLabel: string;
  /** Art des Imports (Datei-Upload / Manuelle Eingabe / Kontrolle …). */
  importType: CockpitImportType;
  /** Sprechendes Aktions-Label („Zur Gastronovi-Importseite" …). */
  actionLabel?: string;
}

export interface ChecklistGroups {
  daily: ChecklistItem[];
  weekly: ChecklistItem[];
  monthly: ChecklistItem[];
  yearly: ChecklistItem[];
}

/** Bildet den Anzeige-Status auf einen Checklisten-Zustand ab. */
export function checklistStateFromStatus(status: CockpitStatus): ChecklistState {
  switch (status) {
    case 'current':
      return 'done';
    case 'overdue':
      return 'overdue';
    case 'uncheckable':
      return 'unknown';
    case 'due_soon':
    case 'never':
    default:
      return 'open';
  }
}

/** Gruppiert die Zeilen nach Intervall in die Checklisten-Ansicht (Heute/Woche/Monat/Jahr). */
export function groupChecklist(rows: CockpitRow[]): ChecklistGroups {
  const groups: ChecklistGroups = { daily: [], weekly: [], monthly: [], yearly: [] };
  for (const row of rows) {
    const item: ChecklistItem = {
      id: row.def.id,
      label: row.def.checklistLabel,
      state: checklistStateFromStatus(row.result.status),
      route: row.def.route,
      uploadLabel: row.def.uploadLabel,
      importType: row.def.importType,
      actionLabel: row.def.actionLabel,
    };
    groups[row.def.interval].push(item);
  }
  return groups;
}

// ─── Filter (rein, testbar) ──────────────────────────────────────────────────────

/** Aktive Filterachsen der Übersicht. `'all'` = keine Einschränkung. */
export interface CockpitFilterState {
  category: 'all' | CockpitCategory;
  importType: 'all' | CockpitImportType;
  interval: 'all' | ImportInterval;
  status: 'all' | CockpitStatus;
  search: string;
}

export const EMPTY_COCKPIT_FILTER: CockpitFilterState = {
  category: 'all',
  importType: 'all',
  interval: 'all',
  status: 'all',
  search: '',
};

/** Freitextsuche über Name, Bereich, Aufgabentext und „Was hochladen?". */
export function matchesCockpitSearch(def: CockpitSourceDef, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  return (
    def.label.toLowerCase().includes(q) ||
    def.module.toLowerCase().includes(q) ||
    def.checklistLabel.toLowerCase().includes(q) ||
    def.uploadLabel.toLowerCase().includes(q) ||
    (def.sourceHint?.toLowerCase().includes(q) ?? false)
  );
}

/** Prüft eine Zeile gegen ALLE aktiven Filterachsen (UND-Verknüpfung). */
export function rowMatchesFilters(row: CockpitRow, f: CockpitFilterState): boolean {
  if (f.category !== 'all' && row.def.category !== f.category) return false;
  if (f.importType !== 'all' && row.def.importType !== f.importType) return false;
  if (f.interval !== 'all' && row.def.interval !== f.interval) return false;
  if (f.status !== 'all' && row.result.status !== f.status) return false;
  return matchesCockpitSearch(row.def, f.search);
}

// ─── Anzeige-Konstanten & Formatter ──────────────────────────────────────────────

export const INTERVAL_LABEL: Record<ImportInterval, string> = {
  daily: 'Täglich',
  weekly: 'Wöchentlich',
  monthly: 'Monatlich',
  yearly: 'Jährlich',
};

/** Anzeigename je Kategorie. */
export const CATEGORY_LABEL: Record<CockpitCategory, string> = {
  reservationen_gaeste: 'Reservationen / Gäste',
  umsatz_gastronovi: 'Umsatz / Gastronovi',
  produkte: 'Produkte',
  personal: 'Personal',
  waren_rechnungen: 'Waren / Rechnungen',
  finanzen_budget: 'Finanzen / Budget',
  planung_kontrolle: 'Planung / Kontrolle',
};

/** Kanonische Reihenfolge der Kategorien für Gruppierung/Filter-Dropdown. */
export const CATEGORY_ORDER: CockpitCategory[] = [
  'reservationen_gaeste',
  'umsatz_gastronovi',
  'produkte',
  'personal',
  'waren_rechnungen',
  'finanzen_budget',
  'planung_kontrolle',
];

/** Anzeigename je Import-Art. */
export const IMPORT_TYPE_LABEL: Record<CockpitImportType, string> = {
  file_upload: 'Datei-Upload',
  manual_entry: 'Manuelle Eingabe',
  control: 'Kontrolle',
  system: 'Automatisch / Systemdaten',
  not_configured: 'Nicht eingerichtet',
};

/** Kanonische Reihenfolge der Import-Arten für das Filter-Dropdown. */
export const IMPORT_TYPE_ORDER: CockpitImportType[] = [
  'file_upload',
  'manual_entry',
  'control',
  'system',
  'not_configured',
];

/** Dezente Badge-Stile je Import-Art (unabhängig von den Status-Farben). */
export const IMPORT_TYPE_BADGE_CLASS: Record<CockpitImportType, string> = {
  file_upload:
    'bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-800',
  manual_entry:
    'bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-800',
  control:
    'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800/60 dark:text-slate-300 dark:border-slate-700',
  system:
    'bg-teal-100 text-teal-700 border-teal-200 dark:bg-teal-950/40 dark:text-teal-300 dark:border-teal-800',
  not_configured: 'bg-muted text-muted-foreground border-border',
};

/** Erklärender Tooltip-Text je Status (nur für unklare Status gefüllt). */
export const STATUS_HINT: Partial<Record<CockpitStatus, string>> = {
  never:
    'Für diese Datenquelle wurde noch kein Importlauf oder kein Datenbestand gefunden.',
  uncheckable:
    'Für diese Datenquelle gibt es noch keine auswertbare Import-Historie oder kein Datumsfeld zur Prüfung.',
};

/** Checklisten-Überschrift je Intervall. */
export const CHECKLIST_GROUP_LABEL: Record<ImportInterval, string> = {
  daily: 'Heute zu erledigen',
  weekly: 'Diese Woche',
  monthly: 'Diesen Monat',
  yearly: 'Dieses Jahr',
};

export const STATUS_LABEL: Record<CockpitStatus, string> = {
  current: 'Aktuell',
  due_soon: 'Bald fällig',
  overdue: 'Überfällig',
  never: 'Nie importiert',
  uncheckable: 'Nicht prüfbar',
};

export const STATUS_BADGE_CLASS: Record<CockpitStatus, string> = {
  current:
    'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800',
  due_soon:
    'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800',
  overdue: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800',
  never: 'bg-muted text-muted-foreground border-border',
  uncheckable: 'bg-muted text-muted-foreground border-border',
};

export const STATUS_DOT_CLASS: Record<CockpitStatus, string> = {
  current: 'bg-emerald-500',
  due_soon: 'bg-amber-400',
  overdue: 'bg-red-500',
  never: 'bg-muted-foreground/40',
  uncheckable: 'bg-muted-foreground/30',
};

export const CHECKLIST_LABEL: Record<ChecklistState, string> = {
  done: 'Erledigt',
  open: 'Offen',
  overdue: 'Überfällig',
  unknown: 'Nicht prüfbar',
};

export const CHECKLIST_BADGE_CLASS: Record<ChecklistState, string> = {
  done: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800',
  open: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800',
  overdue: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800',
  unknown: 'bg-muted text-muted-foreground border-border',
};

/** Formatiert einen Datenstand (yyyy-MM-dd | yyyy-MM | yyyy) als dd.MM.yyyy / MM.yyyy / yyyy. */
export function formatCockpitDate(value: string | null | undefined): string {
  if (!value) return 'Keine Daten';
  const v = value.trim();
  try {
    if (RE_DAY.test(v)) return format(parseISO(v), 'dd.MM.yyyy');
    if (RE_MONTH.test(v)) {
      const [y, m] = v.split('-').map(Number);
      return format(new Date(y, m - 1, 1), 'MM.yyyy');
    }
    if (RE_YEAR.test(v)) return v;
    const d = parseISO(v);
    return Number.isNaN(d.getTime()) ? v : format(d, 'dd.MM.yyyy');
  } catch {
    return v;
  }
}
