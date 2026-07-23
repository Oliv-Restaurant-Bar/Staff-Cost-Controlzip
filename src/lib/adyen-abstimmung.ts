/**
 * adyen-abstimmung.ts — Reine Logik für den Tages-Abgleich Z-Bericht ↔ Adyen.
 * ===========================================================================
 * KEIN DOM, KEIN Supabase — synthetisch getestet (node-Umgebung).
 *
 * Verantwortlich für:
 *   - Datenmodell des Blobs `adyenAbstimmung_v1` (Tage, Overrides, Kommentare,
 *     Tagesbestätigungen) — Persistenz in adyen-abstimmung-db.ts.
 *   - Namens-Mapping Z-Bericht (Freitext) ↔ Adyen (Codes) auf dieselben Keys.
 *   - Manuelle Overrides: {originalValue, correctedValue,
 *     correctedByManualOverride, comment?, updatedAt} — Berechnungen laufen mit
 *     correctedValue, das Original bleibt sichtbar. Overrides leben NUR im
 *     Blob — NIE zurück in gn_imports/gn_payment_methods schreiben.
 *   - Diff-Status (grün/orange/rot) und Tagesbestätigung (canConfirmDay).
 */

import { normalizeAdyenMethod, type AdyenDaySummary, type AdyenParseResult } from './adyen-csv-parser';

// ── Diff-Schwellen ────────────────────────────────────────────────────────────

/**
 * |Diff| ≤ green → grün (5-Rappen-Rundungstoleranz), ≤ orange → orange,
 * darüber rot. In der UI-Legende ausweisen.
 */
export const ADYEN_DIFF_THRESHOLDS = { green: 0.05, orange: 5.0 } as const;

export type AdyenDiffStatus = 'ok' | 'small' | 'large';

export function adyenDiffStatus(diff: number): AdyenDiffStatus {
  const abs = Math.abs(diff);
  if (abs <= ADYEN_DIFF_THRESHOLDS.green) return 'ok';
  if (abs <= ADYEN_DIFF_THRESHOLDS.orange) return 'small';
  return 'large';
}

// ── Blob-Datenmodell ──────────────────────────────────────────────────────────

export const ADYEN_ABSTIMMUNG_KEY = 'adyenAbstimmung_v1';

export interface AdyenStoredDay {
  byMethod: Record<string, number>;
  countByMethod: Record<string, number>;
  total: number;
  transactionCount: number;
  fileName: string;
  importedAt: string; // ISO
}

export interface AdyenOverride {
  originalValue: number;
  correctedValue: number;
  correctedByManualOverride: true;
  comment?: string;
  updatedAt: string; // ISO
}

export interface AdyenComment {
  text: string;
  updatedAt: string; // ISO
}

export interface DayConfirmation {
  /** Tagesabschluss geprüft (kompletter Tag kontrolliert). */
  confirmed: boolean;
  /** Bar kontrolliert (physischer Bargeldbestand gezählt und verglichen). */
  cashCounted: boolean;
  /** Audit: letzte Änderung des confirmed-Flags (Setzen UND Entfernen). */
  confirmedAt?: string; // ISO
  confirmedBy?: string;
  /** Audit: letzte Änderung des cashCounted-Flags (Setzen UND Entfernen). */
  cashCountedAt?: string; // ISO
  cashCountedBy?: string;
  comment?: string;
}

/**
 * Gewünschter Zielzustand einer Tagesbestätigung aus der UI — OHNE
 * Zeitstempel/Benutzer: Audit-Stempel vergibt ausschliesslich
 * applyDayConfirmation. `comment === undefined` lässt den bestehenden
 * Kommentar unverändert; leerer String entfernt ihn.
 */
export interface DayConfirmationInput {
  confirmed: boolean;
  cashCounted: boolean;
  comment?: string;
}

export interface AdyenAbstimmungBlob {
  /** Importierte Adyen-Tagessummen, Key = yyyy-MM-dd. */
  days: Record<string, AdyenStoredDay>;
  /** Anzeige-Labels je Zahlungsarten-Key (aus allen Importen gesammelt). */
  methodLabels: Record<string, string>;
  /** Manuelle Overrides, Key = FieldKey. */
  overrides: Record<string, AdyenOverride>;
  /** Kommentare, Key = FieldKey. */
  comments: Record<string, AdyenComment>;
  /** Tagesbestätigungen, Key = yyyy-MM-dd. */
  confirmations: Record<string, DayConfirmation>;
}

export function emptyAdyenBlob(): AdyenAbstimmungBlob {
  return { days: {}, methodLabels: {}, overrides: {}, comments: {}, confirmations: {} };
}

/** Defensive Normalisierung eines (evtl. beschädigten) geladenen Blobs. */
export function normalizeAdyenBlob(raw: unknown): AdyenAbstimmungBlob {
  const empty = emptyAdyenBlob();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  const o = raw as Partial<AdyenAbstimmungBlob>;
  const isObj = (v: unknown): v is Record<string, never> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  return {
    days:          isObj(o.days)          ? (o.days          as AdyenAbstimmungBlob['days'])          : {},
    methodLabels:  isObj(o.methodLabels)  ? (o.methodLabels  as AdyenAbstimmungBlob['methodLabels'])  : {},
    overrides:     isObj(o.overrides)     ? (o.overrides     as AdyenAbstimmungBlob['overrides'])     : {},
    comments:      isObj(o.comments)      ? (o.comments      as AdyenAbstimmungBlob['comments'])      : {},
    confirmations: isObj(o.confirmations) ? (o.confirmations as AdyenAbstimmungBlob['confirmations']) : {},
  };
}

/**
 * Merged einen neuen Adyen-Import in den bestehenden Blob:
 * NUR die importierten Tage werden ersetzt — Overrides, Kommentare und
 * Bestätigungen bleiben IMMER erhalten (auch für die ersetzten Tage).
 */
export function mergeAdyenImport(
  blob: AdyenAbstimmungBlob,
  parsed: Pick<AdyenParseResult, 'days' | 'methodLabels'>,
  fileName: string,
  importedAt: string,
): AdyenAbstimmungBlob {
  const days = { ...blob.days };
  for (const d of parsed.days) {
    days[d.date] = {
      byMethod: { ...d.byMethod },
      countByMethod: { ...d.countByMethod },
      total: d.total,
      transactionCount: d.transactionCount,
      fileName,
      importedAt,
    };
  }
  return {
    ...blob,
    days,
    methodLabels: { ...blob.methodLabels, ...parsed.methodLabels },
  };
}

// ── FieldKeys ─────────────────────────────────────────────────────────────────

export type FieldSource = 'zbericht' | 'adyen';

/** Stabiler Schlüssel für Override/Kommentar an einer Zahl. */
export function makeFieldKey(date: string, source: FieldSource, methodKey: string): string {
  return `${date}:${source}:${methodKey}`;
}

// ── Z-Bericht-Zahlungsarten-Mapping ───────────────────────────────────────────

export interface GnDayPayment {
  name: string;
  count: number;
  amount: number;
}

export interface NormalizedGnMethod {
  key: string;
  label: string;
  /** Zählt zur Karten/TWINT-Summe (Vergleichsbasis gegen Adyen)? */
  isCard: boolean;
  /**
   * Kartenähnliche Zahlungsart fürs KK-Total der Tagesabschluss-Übersicht und
   * den separaten Zahlungsweg im Buchhaltungs-Export. Umfasst alle isCard-
   * Methoden PLUS Karten, die NICHT über Adyen abgewickelt werden (PostCard,
   * Lunch-Check, Stripe) — diese dürfen NIE in die Adyen-Vergleichsbasis
   * (isCard) einfliessen, sonst entstehen falsche Adyen-Differenzen.
   */
  isKkCard: boolean;
}

/**
 * Normalisiert einen Z-Bericht-Zahlungsarten-Namen (Freitext) auf denselben
 * Key-Raum wie die Adyen-Codes (mastercard/visa/amex/twint/maestro/…).
 */
export function normalizeGnPaymentName(raw: string): NormalizedGnMethod {
  const v = raw.trim().toLowerCase();
  if (/(mastercard|master card)/.test(v) || v === 'mc') return { key: 'mastercard', label: 'Mastercard', isCard: true, isKkCard: true };
  if (/visa/.test(v))                                    return { key: 'visa', label: 'Visa', isCard: true, isKkCard: true };
  if (/(amex|american express)/.test(v))                 return { key: 'amex', label: 'American Express', isCard: true, isKkCard: true };
  if (/twint/.test(v))                                   return { key: 'twint', label: 'TWINT', isCard: true, isKkCard: true };
  if (/maestro/.test(v))                                 return { key: 'maestro', label: 'Maestro', isCard: true, isKkCard: true };
  // Kartenähnliche Zahlarten OHNE Adyen-Abwicklung: zählen ins KK-Total und
  // werden im Export separat gebucht, aber NICHT gegen Adyen verglichen.
  if (/post\s*-?\s*(finance\s*)?card|postfinance/.test(v)) return { key: 'postcard', label: 'PostCard', isCard: false, isKkCard: true };
  if (/lunch[\s-]*check/.test(v))                          return { key: 'lunch_check', label: 'Lunch-Check', isCard: false, isKkCard: true };
  if (/stripe/.test(v))                                    return { key: 'stripe', label: 'Stripe', isCard: false, isKkCard: true };
  if (/(kreditkarte|kartenzahlung|debitkarte|ec[- ]karte|\bkarte\b)/.test(v)) {
    return { key: 'karte', label: raw.trim() || 'Kartenzahlung', isCard: true, isKkCard: true };
  }
  const key = v.replace(/[^a-z0-9äöü]+/g, '_').replace(/^_+|_+$/g, '') || 'unbekannt';
  return { key, label: raw.trim() || 'Unbekannt', isCard: false, isKkCard: false };
}

// ── Effektive Werte (Override-aware) ─────────────────────────────────────────

export interface EffectiveValue {
  value: number;
  original: number;
  overridden: boolean;
  override?: AdyenOverride;
}

/** Liefert den Rechenwert einer Zahl: correctedValue wenn Override, sonst auto. */
export function effectiveValue(
  overrides: Record<string, AdyenOverride>,
  fieldKey: string,
  autoValue: number,
): EffectiveValue {
  const ov = overrides[fieldKey];
  if (ov && ov.correctedByManualOverride) {
    return { value: ov.correctedValue, original: ov.originalValue, overridden: true, override: ov };
  }
  return { value: autoValue, original: autoValue, overridden: false };
}

// ── Tagesvergleich ────────────────────────────────────────────────────────────

/** Feste Reihenfolge der bekannten Karten/TWINT-Zeilen; Rest alphabetisch. */
const METHOD_ORDER = ['mastercard', 'visa', 'amex', 'twint', 'maestro', 'karte'];

export interface MethodComparisonRow {
  methodKey: string;
  label: string;
  /** Z-Bericht-Seite (undefined = Zahlungsart existiert dort nicht). */
  zbericht?: EffectiveValue;
  /** Adyen-Seite (undefined = Zahlungsart existiert dort nicht). */
  adyen?: EffectiveValue;
  /** Differenz Z-Bericht − Adyen (fehlende Seite zählt als 0). */
  diff: number;
  diffStatus: AdyenDiffStatus;
  zberichtFieldKey: string;
  adyenFieldKey: string;
  zberichtComment?: AdyenComment;
  adyenComment?: AdyenComment;
}

export interface NonCardRow {
  methodKey: string;
  label: string;
  value: EffectiveValue;
  count: number;
  fieldKey: string;
  comment?: AdyenComment;
}

export interface DayComparison {
  date: string;
  hasZbericht: boolean;
  hasAdyen: boolean;
  /** Karten/TWINT-Zeilen (Union beider Seiten). */
  rows: MethodComparisonRow[];
  /** Nicht-Karten-Zahlungsarten aus dem Z-Bericht (Bar, Gutscheine, …). */
  nonCardRows: NonCardRow[];
  /** Karten/TWINT-Total laut Z-Bericht (effektiv, inkl. Total-Override). */
  cardTotalZ: EffectiveValue | null;
  /** Karten/TWINT-Total laut Adyen (effektiv, inkl. Total-Override). */
  cardTotalAdyen: EffectiveValue | null;
  totalDiff: number | null;
  totalStatus: AdyenDiffStatus | null;
  totalZFieldKey: string;
  totalAdyenFieldKey: string;
  totalZComment?: AdyenComment;
  totalAdyenComment?: AdyenComment;
  /** Tageszeilen-Badges. */
  hasOverrides: boolean;
  hasComments: boolean;
  confirmation: DayConfirmation | null;
}

function sortMethodKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    const ia = METHOD_ORDER.indexOf(a);
    const ib = METHOD_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Baut den vollständigen Tagesvergleich.
 * @param gnPayments  Zahlungsarten des Z-Bericht-Tagesimports; null = KEIN Z-Bericht.
 * @param adyenDay    Adyen-Tagessumme aus dem Blob; null = kein Adyen-Import.
 */
export function buildDayComparison(
  date: string,
  gnPayments: GnDayPayment[] | null,
  adyenDay: AdyenStoredDay | null,
  blob: AdyenAbstimmungBlob,
): DayComparison {
  const { overrides, comments, confirmations, methodLabels } = blob;

  // Z-Bericht-Seite: pro (Key) summieren, Karten von Nicht-Karten trennen.
  const zCard = new Map<string, { label: string; amount: number }>();
  const zNonCard = new Map<string, { label: string; amount: number; count: number }>();
  for (const p of gnPayments ?? []) {
    const norm = normalizeGnPaymentName(p.name);
    if (norm.isCard) {
      const prev = zCard.get(norm.key);
      zCard.set(norm.key, { label: norm.label, amount: round2((prev?.amount ?? 0) + p.amount) });
    } else {
      const prev = zNonCard.get(norm.key);
      zNonCard.set(norm.key, {
        label: prev?.label ?? norm.label,
        amount: round2((prev?.amount ?? 0) + p.amount),
        count: (prev?.count ?? 0) + p.count,
      });
    }
  }

  const hasZbericht = gnPayments !== null;
  const hasAdyen = adyenDay !== null;

  // Karten/TWINT-Zeilen: Union beider Seiten.
  const keys = sortMethodKeys([
    ...new Set([...zCard.keys(), ...Object.keys(adyenDay?.byMethod ?? {})]),
  ]);

  const rows: MethodComparisonRow[] = keys.map(key => {
    const zEntry = zCard.get(key);
    const aAmount = adyenDay?.byMethod[key];
    const zKey = makeFieldKey(date, 'zbericht', key);
    const aKey = makeFieldKey(date, 'adyen', key);
    const z = zEntry !== undefined ? effectiveValue(overrides, zKey, zEntry.amount) : undefined;
    const a = aAmount !== undefined ? effectiveValue(overrides, aKey, aAmount) : undefined;
    const diff = round2((z?.value ?? 0) - (a?.value ?? 0));
    return {
      methodKey: key,
      label: zEntry?.label ?? methodLabels[key] ?? key,
      zbericht: z,
      adyen: a,
      diff,
      diffStatus: adyenDiffStatus(diff),
      zberichtFieldKey: zKey,
      adyenFieldKey: aKey,
      zberichtComment: comments[zKey],
      adyenComment: comments[aKey],
    };
  });

  // Totale: Auto-Wert = Summe der EFFEKTIVEN Zeilenwerte; Total-Override ersetzt.
  const totalZKey = makeFieldKey(date, 'zbericht', 'total');
  const totalAKey = makeFieldKey(date, 'adyen', 'total');
  const autoTotalZ = round2(rows.reduce((s, r) => s + (r.zbericht?.value ?? 0), 0));
  const autoTotalA = round2(rows.reduce((s, r) => s + (r.adyen?.value ?? 0), 0));
  const cardTotalZ = hasZbericht ? effectiveValue(overrides, totalZKey, autoTotalZ) : null;
  const cardTotalAdyen = hasAdyen ? effectiveValue(overrides, totalAKey, autoTotalA) : null;
  const totalDiff = cardTotalZ !== null && cardTotalAdyen !== null
    ? round2(cardTotalZ.value - cardTotalAdyen.value)
    : null;

  const nonCardRows: NonCardRow[] = [...zNonCard.entries()]
    .sort((a, b) => a[1].label.localeCompare(b[1].label, 'de'))
    .map(([key, v]) => {
      const fieldKey = makeFieldKey(date, 'zbericht', key);
      return {
        methodKey: key,
        label: v.label,
        value: effectiveValue(overrides, fieldKey, v.amount),
        count: v.count,
        fieldKey,
        comment: comments[fieldKey],
      };
    });

  const prefix = `${date}:`;
  const hasOverrides = Object.keys(overrides).some(k => k.startsWith(prefix));
  const hasComments = Object.keys(comments).some(k => k.startsWith(prefix));

  return {
    date,
    hasZbericht,
    hasAdyen,
    rows,
    nonCardRows,
    cardTotalZ,
    cardTotalAdyen,
    totalDiff,
    totalStatus: totalDiff !== null ? adyenDiffStatus(totalDiff) : null,
    totalZFieldKey: totalZKey,
    totalAdyenFieldKey: totalAKey,
    totalZComment: comments[totalZKey],
    totalAdyenComment: comments[totalAKey],
    hasOverrides,
    hasComments,
    confirmation: confirmations[date] ?? null,
  };
}

// ── Tagesbestätigung ──────────────────────────────────────────────────────────

export interface ConfirmCheck {
  ok: boolean;
  /** Konkrete, anzeigbare Gründe, warum der Tag (noch) nicht bestätigbar ist. */
  missing: string[];
}

/**
 * Ein Tag darf erst bestätigt werden, wenn:
 *   1. der Z-Bericht (Tagesimport) vorhanden ist,
 *   2. der Adyen-Abgleich geprüft ist: alle Karten-Diffs grün ODER jede
 *      nicht-grüne Differenz manuell übersteuert oder kommentiert wurde,
 *   3. der Barbestand bestätigt wurde (cashCounted).
 */
export function canConfirmDay(cmp: DayComparison, cashCounted: boolean): ConfirmCheck {
  const missing: string[] = [];
  if (!cmp.hasZbericht) missing.push('Z-Bericht fehlt');

  if (!cmp.hasAdyen) {
    missing.push('Adyen-Import fehlt');
  } else {
    const unresolved: string[] = [];
    for (const r of cmp.rows) {
      if (r.diffStatus === 'ok') continue;
      const overridden = r.zbericht?.overridden || r.adyen?.overridden;
      const commented = !!r.zberichtComment || !!r.adyenComment;
      if (!overridden && !commented) unresolved.push(r.label);
    }
    if (cmp.totalStatus !== null && cmp.totalStatus !== 'ok') {
      const totalOverridden = cmp.cardTotalZ?.overridden || cmp.cardTotalAdyen?.overridden;
      const totalCommented = !!cmp.totalZComment || !!cmp.totalAdyenComment;
      if (!totalOverridden && !totalCommented && unresolved.length === 0) unresolved.push('Total');
    }
    if (unresolved.length > 0) {
      missing.push(`Differenz ungeklärt (${unresolved.join(', ')}) — übersteuern oder kommentieren`);
    }
  }

  if (!cashCounted) missing.push('Barbestand nicht bestätigt');
  return { ok: missing.length === 0, missing };
}

// ── Mutationen (rein, immutabel) ──────────────────────────────────────────────

/** Setzt oder entfernt einen Override. correctedValue===null entfernt ihn. */
export function setOverride(
  blob: AdyenAbstimmungBlob,
  fieldKey: string,
  originalValue: number,
  correctedValue: number | null,
  comment: string | undefined,
  now: string,
): AdyenAbstimmungBlob {
  const overrides = { ...blob.overrides };
  if (correctedValue === null) {
    delete overrides[fieldKey];
  } else {
    const existing = overrides[fieldKey];
    overrides[fieldKey] = {
      // Original des ERSTEN Overrides behalten — nie den korrigierten Wert
      // als neues "Original" verankern.
      originalValue: existing ? existing.originalValue : originalValue,
      correctedValue,
      correctedByManualOverride: true,
      ...(comment !== undefined && comment.trim() !== '' ? { comment: comment.trim() } : {}),
      updatedAt: now,
    };
  }
  return { ...blob, overrides };
}

/** Setzt oder entfernt einen Kommentar (leerer Text entfernt). */
export function setComment(
  blob: AdyenAbstimmungBlob,
  fieldKey: string,
  text: string,
  now: string,
): AdyenAbstimmungBlob {
  const comments = { ...blob.comments };
  const trimmed = text.trim();
  if (trimmed === '') delete comments[fieldKey];
  else comments[fieldKey] = { text: trimmed, updatedAt: now };
  return { ...blob, comments };
}

/** Setzt die Tagesbestätigung (oder hebt sie auf). */
export function setDayConfirmation(
  blob: AdyenAbstimmungBlob,
  date: string,
  confirmation: DayConfirmation | null,
): AdyenAbstimmungBlob {
  const confirmations = { ...blob.confirmations };
  if (confirmation === null) delete confirmations[date];
  else confirmations[date] = confirmation;
  return { ...blob, confirmations };
}

/**
 * ZENTRALER Schreibpfad für Tagesbestätigungen (Tagesabschlüsse UND
 * Adyen-Abgleich) mit Audit-Trail und Dirty-Check:
 *   - Keine fachliche Änderung ⇒ es wird DIESELBE Blob-Referenz
 *     zurückgegeben — der Aufrufer persistiert dann NICHT (kein unnötiger
 *     Write, kein updatedAt-Bump).
 *   - Benutzer + Zeitstempel werden NUR für Flags gestempelt, die sich
 *     tatsächlich ändern — beim Setzen UND beim Entfernen; unveränderte
 *     Flags behalten ihren bisherigen Stempel.
 *   - `next.comment === undefined` lässt den Kommentar unverändert,
 *     leerer/whitespace-String entfernt ihn; Kommentar-only-Änderungen
 *     stempeln keine Flag-Audits.
 */
export function applyDayConfirmation(
  blob: AdyenAbstimmungBlob,
  date: string,
  next: DayConfirmationInput,
  user: string,
  now: string,
): AdyenAbstimmungBlob {
  const prev = blob.confirmations[date];
  const prevConfirmed = prev?.confirmed === true;
  const prevCashCounted = prev?.cashCounted === true;
  const trimmed = next.comment === undefined ? undefined : next.comment.trim();
  const nextComment = trimmed === undefined
    ? prev?.comment
    : (trimmed === '' ? undefined : trimmed);

  const confirmedChanged = prevConfirmed !== next.confirmed;
  const cashCountedChanged = prevCashCounted !== next.cashCounted;
  const commentChanged = (prev?.comment ?? undefined) !== nextComment;
  if (!confirmedChanged && !cashCountedChanged && !commentChanged) return blob;

  const entry: DayConfirmation = {
    confirmed: next.confirmed,
    cashCounted: next.cashCounted,
    ...(cashCountedChanged
      ? { cashCountedAt: now, cashCountedBy: user }
      : {
          ...(prev?.cashCountedAt ? { cashCountedAt: prev.cashCountedAt } : {}),
          ...(prev?.cashCountedBy ? { cashCountedBy: prev.cashCountedBy } : {}),
        }),
    ...(confirmedChanged
      ? { confirmedAt: now, confirmedBy: user }
      : {
          ...(prev?.confirmedAt ? { confirmedAt: prev.confirmedAt } : {}),
          ...(prev?.confirmedBy ? { confirmedBy: prev.confirmedBy } : {}),
        }),
    ...(nextComment !== undefined ? { comment: nextComment } : {}),
  };
  return { ...blob, confirmations: { ...blob.confirmations, [date]: entry } };
}

// ── Cockpit-Signal-Helfer (read-only) ─────────────────────────────────────────

/**
 * Liefert die importierten Adyen-Tage (aufsteigend, nur ≤ today) für das
 * Import-Cockpit-Signal. Liest NUR — nie über die Save-Schicht verwenden.
 */
export function adyenDaysFromBlob(raw: unknown, today: string): string[] {
  const blob = normalizeAdyenBlob(raw);
  return Object.keys(blob.days)
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today)
    .sort();
}

export type { AdyenDaySummary };
