/**
 * Gemeinsame Tagesanalyse (Personen / Umsatz pro Person / Durchschnittsbon)
 *
 * REINE LOGIK — kein DOM, kein Supabase (nur Typen).
 *
 * Führt die drei KPI-Quellen (Anzahl Personen, Umsatz pro Person,
 * Durchschnittsbon) mit den Umsatzquellen (Z-Bericht, validierter
 * Tagesumsatz) pro Kalendertag zusammen.  Die Mandanten-Trennung erfolgt
 * beim Aufrufer (DB-Schicht lädt tenant-gefiltert) — dieses Modul arbeitet
 * auf bereits tenant-reinen Tageswerten.
 *
 * Grundregeln (Auftrag):
 * - Quellenpriorität Umsatz: Z-Bericht > validierter Tagesumsatz >
 *   Personen × Umsatz pro Person.  Der berechnete Umsatz überschreibt
 *   NIEMALS einen vorhandenen Z-Bericht-Umsatz.
 * - Bonanzahl = primärer Umsatz ÷ Durchschnittsbon.
 * - Personen pro Bon = Personen ÷ berechnete Bonanzahl.
 * - Keine Division durch 0; fehlend = null, NIE 0.
 * - Periodenwerte sind GEWICHTET (Summen bzw. Quotienten von Summen über
 *   Tage, an denen beide Seiten vorhanden sind) — keine einfachen
 *   Mittelwerte von Tagesdurchschnitten.
 */

// ── Typen ─────────────────────────────────────────────────────────────────────

/** Roh-Eingaben eines Kalendertags (alles optional — fehlend = null). */
export interface GnTagesInput {
  /** ISO-Datum yyyy-MM-dd */
  date: string;
  /** Anzahl Personen (aus Personen-Bericht) */
  persons?: number | null;
  /** Umsatz pro Person (aus Umsatz-pro-Person-Bericht) */
  revenuePerPerson?: number | null;
  /** Durchschnittsbon CHF (aus Durchschnittsbon-Bericht) */
  averageReceipt?: number | null;
  /** Bruttoumsatz gemäss Z-Bericht (Tages-Geschäftstag) */
  zRevenue?: number | null;
  /** Validierter Tagesumsatz (Tagesansicht/Umsatzabstimmung) */
  validatedRevenue?: number | null;
}

export type GnPrimaryRevenueSource = 'zbericht' | 'tagesumsatz' | 'berechnet';

/** Analyse-Ergebnis eines Kalendertags. */
export interface GnTagesAnalyse {
  date: string;
  persons: number | null;
  revenuePerPerson: number | null;
  averageReceipt: number | null;
  /** Personen × Umsatz pro Person (nur wenn beide vorhanden) */
  derivedRevenue: number | null;
  /** Primärer Umsatz nach Quellenpriorität */
  primaryRevenue: number | null;
  primaryRevenueSource: GnPrimaryRevenueSource | null;
  /** Primärer Umsatz ÷ Durchschnittsbon */
  derivedReceiptCount: number | null;
  /** Personen ÷ berechnete Bonanzahl */
  derivedPersonsPerReceipt: number | null;
}

/** Gewichtete Periodenwerte über mehrere Tage. */
export interface GnPeriodenAnalyse {
  /** Tage mit mindestens einem Wert */
  dayCount: number;
  /** Tage mit Personenzahl */
  personDayCount: number;
  /** Summe Personen */
  persons: number | null;
  /** Summe primärer Umsatz */
  primaryRevenue: number | null;
  /** Gesamtumsatz ÷ Gesamtpersonen (nur Tage mit beidem) */
  revenuePerPerson: number | null;
  /** Gesamtumsatz ÷ Gesamtbonanzahl (nur Tage mit beidem) */
  averageReceipt: number | null;
  /** Summe berechnete Bonanzahl */
  derivedReceiptCount: number | null;
  /** Gesamtpersonen ÷ Gesamtbonanzahl (nur Tage mit beidem) */
  personsPerReceipt: number | null;
}

/** UI-Tooltip für «Bons, berechnet» (zentral definiert, exakter Auftrags-Text). */
export const BONS_BERECHNET_TOOLTIP =
  'Aus Umsatz und Durchschnittsbon berechnet. Aufgrund gerundeter Berichtswerte kann die Anzahl leicht abweichen.';

// ── Hilfen ────────────────────────────────────────────────────────────────────

/** Endlicher Wert > 0, sonst null (leer ≠ 0; 0 ist kein brauchbarer Divisor/Faktor). */
function pos(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/** Endlicher Wert ≥ 0, sonst null (0 bleibt als echter Wert erhalten, z. B. 0 Personen). */
function nonNeg(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

// ── Tages-Analyse ─────────────────────────────────────────────────────────────

export function analyzeGnTag(input: GnTagesInput): GnTagesAnalyse {
  const persons          = nonNeg(input.persons);
  const revenuePerPerson = pos(input.revenuePerPerson);
  const averageReceipt   = pos(input.averageReceipt);
  const zRevenue         = pos(input.zRevenue);
  const validatedRevenue = pos(input.validatedRevenue);

  // Berechneter Umsatz: Personen × Umsatz pro Person (beide vorhanden, Personen > 0)
  const derivedRevenue =
    persons !== null && persons > 0 && revenuePerPerson !== null
      ? persons * revenuePerPerson
      : null;

  // Quellenpriorität: Z-Bericht > validierter Tagesumsatz > berechnet.
  // Ein berechneter Wert überschreibt NIE einen vorhandenen Z-Bericht-Umsatz.
  let primaryRevenue: number | null = null;
  let primaryRevenueSource: GnPrimaryRevenueSource | null = null;
  if (zRevenue !== null) {
    primaryRevenue = zRevenue;
    primaryRevenueSource = 'zbericht';
  } else if (validatedRevenue !== null) {
    primaryRevenue = validatedRevenue;
    primaryRevenueSource = 'tagesumsatz';
  } else if (derivedRevenue !== null) {
    primaryRevenue = derivedRevenue;
    primaryRevenueSource = 'berechnet';
  }

  // Bonanzahl = primärer Umsatz ÷ Durchschnittsbon (keine Division durch 0)
  const derivedReceiptCount =
    primaryRevenue !== null && averageReceipt !== null
      ? primaryRevenue / averageReceipt
      : null;

  // Personen pro Bon = Personen ÷ Bonanzahl (keine Division durch 0)
  const derivedPersonsPerReceipt =
    persons !== null && derivedReceiptCount !== null && derivedReceiptCount > 0
      ? persons / derivedReceiptCount
      : null;

  return {
    date: input.date,
    persons,
    revenuePerPerson,
    averageReceipt,
    derivedRevenue,
    primaryRevenue,
    primaryRevenueSource,
    derivedReceiptCount,
    derivedPersonsPerReceipt,
  };
}

export function analyzeGnTage(inputs: GnTagesInput[]): GnTagesAnalyse[] {
  return inputs.map(analyzeGnTag);
}

// ── Perioden-Analyse (gewichtet) ──────────────────────────────────────────────

/**
 * Gewichtete Periodenwerte:
 * - Personen / Umsatz / Bonanzahl: Summen der vorhandenen Tageswerte.
 * - Quotienten (Umsatz pro Person, Durchschnittsbon, Personen pro Bon):
 *   Quotienten von Summen über GEPAARTE Tage (beide Seiten vorhanden) —
 *   sonst würde ein Tag mit Umsatz aber ohne Personen den Quotienten
 *   verfälschen.  Keine Mittelwerte von Tagesdurchschnitten.
 */
export function summarizeGnPeriode(days: GnTagesAnalyse[]): GnPeriodenAnalyse {
  let dayCount = 0;
  let personDayCount = 0;

  let personsSum: number | null = null;
  let revenueSum: number | null = null;
  let receiptSum: number | null = null;

  // Gepaarte Summen für die Quotienten
  let revWithPersons = 0, personsWithRev = 0, hasRevPersonPair = false;
  let revWithReceipts = 0, receiptsWithRev = 0, hasRevReceiptPair = false;
  let personsWithReceipts = 0, receiptsWithPersons = 0, hasPersonReceiptPair = false;

  for (const d of days) {
    const hasAny =
      d.persons !== null || d.revenuePerPerson !== null || d.averageReceipt !== null ||
      d.primaryRevenue !== null;
    if (hasAny) dayCount++;

    if (d.persons !== null) {
      personDayCount++;
      personsSum = (personsSum ?? 0) + d.persons;
    }
    if (d.primaryRevenue !== null) revenueSum = (revenueSum ?? 0) + d.primaryRevenue;
    if (d.derivedReceiptCount !== null) receiptSum = (receiptSum ?? 0) + d.derivedReceiptCount;

    if (d.primaryRevenue !== null && d.persons !== null && d.persons > 0) {
      revWithPersons += d.primaryRevenue;
      personsWithRev += d.persons;
      hasRevPersonPair = true;
    }
    if (d.primaryRevenue !== null && d.derivedReceiptCount !== null && d.derivedReceiptCount > 0) {
      revWithReceipts += d.primaryRevenue;
      receiptsWithRev += d.derivedReceiptCount;
      hasRevReceiptPair = true;
    }
    if (d.persons !== null && d.derivedReceiptCount !== null && d.derivedReceiptCount > 0) {
      personsWithReceipts += d.persons;
      receiptsWithPersons += d.derivedReceiptCount;
      hasPersonReceiptPair = true;
    }
  }

  return {
    dayCount,
    personDayCount,
    persons: personsSum,
    primaryRevenue: revenueSum,
    revenuePerPerson:
      hasRevPersonPair && personsWithRev > 0 ? revWithPersons / personsWithRev : null,
    averageReceipt:
      hasRevReceiptPair && receiptsWithRev > 0 ? revWithReceipts / receiptsWithRev : null,
    derivedReceiptCount: receiptSum,
    personsPerReceipt:
      hasPersonReceiptPair && receiptsWithPersons > 0
        ? personsWithReceipts / receiptsWithPersons
        : null,
  };
}

// ── Eingabe-Merge (aus Tages-Rohlisten) ──────────────────────────────────────

export interface GnTagesQuellen {
  /** date → Personen */
  personsByDate?: ReadonlyMap<string, number>;
  /** date → Umsatz pro Person */
  revenuePerPersonByDate?: ReadonlyMap<string, number>;
  /** date → Durchschnittsbon */
  averageReceiptByDate?: ReadonlyMap<string, number>;
  /** date → Z-Bericht-Bruttoumsatz */
  zRevenueByDate?: ReadonlyMap<string, number>;
  /** date → validierter Tagesumsatz */
  validatedRevenueByDate?: ReadonlyMap<string, number>;
}

/**
 * Führt Tages-Rohquellen über das Kalenderdatum zusammen und analysiert
 * jeden Tag.  Es entstehen nur Einträge für Daten, die in mindestens einer
 * Quelle vorkommen (fehlende Tage werden nicht als 0 erfunden).
 */
export function mergeGnTagesQuellen(quellen: GnTagesQuellen): GnTagesAnalyse[] {
  const dates = new Set<string>();
  for (const m of [
    quellen.personsByDate, quellen.revenuePerPersonByDate, quellen.averageReceiptByDate,
    quellen.zRevenueByDate, quellen.validatedRevenueByDate,
  ]) {
    if (m) for (const d of m.keys()) dates.add(d);
  }

  const sorted = [...dates].sort((a, b) => a.localeCompare(b));
  return sorted.map(date => analyzeGnTag({
    date,
    persons:          quellen.personsByDate?.get(date) ?? null,
    revenuePerPerson: quellen.revenuePerPersonByDate?.get(date) ?? null,
    averageReceipt:   quellen.averageReceiptByDate?.get(date) ?? null,
    zRevenue:         quellen.zRevenueByDate?.get(date) ?? null,
    validatedRevenue: quellen.validatedRevenueByDate?.get(date) ?? null,
  }));
}
