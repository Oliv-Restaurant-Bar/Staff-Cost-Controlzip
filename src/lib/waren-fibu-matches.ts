/**
 * waren-fibu-matches.ts — manuelles Matching Erfasste Rechnungen ↔ Buchungen
 * ==========================================================================
 * FIBU-Abgleich-Detail je Lieferant: eine oder mehrere erfasste Rechnungen
 * werden manuell mit einer oder mehreren Buchungen zu einer Match-Gruppe
 * zusammengefasst (N:M). REIN ZUORDNEND/VISUELL — es werden keine Beträge
 * verändert oder umgebucht, nur die Zugehörigkeit markiert.
 *
 * Persistenz: pro Mandant und Monat (KV, siehe waren-db). Buchungen haben
 * keine stabile ID — der Schlüssel wird deterministisch aus den Feldern
 * gebildet (Datum|Text|Konto|Soll|Haben + Laufindex bei Duplikaten).
 */

import type { InvoiceEntry } from '@/lib/waren-db';
import type { SageJournalEntry } from '@/types/reporting';

export interface FibuMatchGruppe {
  id: string;
  /** IDs der erfassten Rechnungen (InvoiceEntry.id). */
  invoiceIds: string[];
  /** Deterministische Buchungs-Schlüssel (buchungKey). */
  buchungKeys: string[];
  /** Herkunft: automatisch vorgeschlagen oder manuell gesetzt. Fehlt bei Alt-Daten → 'manuell'. */
  herkunft?: 'auto' | 'manuell';
}

/**
 * Persistierter Zustand pro Mandant+Monat. `gesperrt` = Mitglieder manuell
 * AUFGELÖSTER Matches: der Auto-Lauf fasst sie NIE wieder an (manuelle
 * Entscheidung bleibt stehen); manuelles Matchen ist weiterhin möglich
 * (ein neues manuelles Match entsperrt seine Mitglieder wieder).
 */
export interface FibuMatchState {
  gruppen: FibuMatchGruppe[];
  gesperrt: { invoiceIds: string[]; buchungKeys: string[] };
}

export const LEERER_MATCH_STATE: FibuMatchState = { gruppen: [], gesperrt: { invoiceIds: [], buchungKeys: [] } };

/** Standard-Toleranz für Auto-Match und grüne Ampel (absolute CHF-Differenz). */
export const DEFAULT_FIBU_MATCH_TOLERANZ = 10;

/** Deterministischer Schlüssel einer Buchungszeile (ohne stabile ID). */
export function buchungKey(b: SageJournalEntry): string {
  return [b.date, b.text ?? '', b.accountNumber ?? '', b.soll ?? 0, b.haben ?? 0].join('|');
}

/**
 * Schlüssel MIT Duplikat-Index: identische Zeilen (gleicher Betrag/Text/Tag,
 * z.B. zwei gleiche Tagesrechnungen) bekommen `#0`, `#1`, … — sonst würde
 * ein Match beide markieren. Reihenfolge = Anzeige-Reihenfolge der Liste.
 */
export function buchungKeysMitIndex(buchungen: SageJournalEntry[]): string[] {
  const seen = new Map<string, number>();
  return buchungen.map(b => {
    const base = buchungKey(b);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}#${n}`;
  });
}

/** Betrag einer Buchungszeile (Aufwandskonto: Soll − Haben). */
export function buchungBetrag(b: SageJournalEntry): number {
  return (b.soll ?? 0) - (b.haben ?? 0);
}

/** ISO-Datum (yyyy-mm-dd) → dd.mm.yyyy; andere Formate unverändert. */
export function fmtDatumCH(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : (iso ?? '');
}

/** Tolerante Normalisierung eines gespeicherten Blobs (nie werfen). */
export function normalizeFibuMatches(raw: unknown): FibuMatchGruppe[] {
  if (!raw || typeof raw !== 'object') return [];
  const arr = (raw as { gruppen?: unknown }).gruppen;
  if (!Array.isArray(arr)) return [];
  const out: FibuMatchGruppe[] = [];
  for (const g of arr) {
    if (!g || typeof g !== 'object') continue;
    const o = g as Record<string, unknown>;
    const invoiceIds = Array.isArray(o.invoiceIds) ? o.invoiceIds.filter((x): x is string => typeof x === 'string') : [];
    const buchungKeys = Array.isArray(o.buchungKeys) ? o.buchungKeys.filter((x): x is string => typeof x === 'string') : [];
    if (invoiceIds.length === 0 && buchungKeys.length === 0) continue;
    out.push({
      id: typeof o.id === 'string' && o.id ? o.id : `m-${out.length}`,
      invoiceIds, buchungKeys,
      herkunft: o.herkunft === 'auto' ? 'auto' : 'manuell', // Alt-Daten = manuell
    });
  }
  return out;
}

/** Tolerante Normalisierung des gesamten Match-Zustands (inkl. Sperrliste). */
export function normalizeFibuMatchState(raw: unknown): FibuMatchState {
  const gruppen = normalizeFibuMatches(raw);
  const g = (raw && typeof raw === 'object' ? (raw as { gesperrt?: unknown }).gesperrt : null) as
    { invoiceIds?: unknown; buchungKeys?: unknown } | null;
  const strArr = (x: unknown): string[] =>
    Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : [];
  return {
    gruppen,
    gesperrt: { invoiceIds: strArr(g?.invoiceIds), buchungKeys: strArr(g?.buchungKeys) },
  };
}

export type MatchAmpel = 'gruen' | 'gelb' | 'rot';

/**
 * Ampel für eine (Vorschau-)Gruppe: absolute Differenz ≤ Toleranz (Default
 * CHF 10.00) = grün; sonst < 5 % der grösseren Seite = gelb; darüber rot.
 * Nie durch 0 teilen: sind beide Seiten 0, ist die Differenz 0 → grün.
 */
export function matchAmpel(erfasst: number, gebucht: number, toleranz: number = DEFAULT_FIBU_MATCH_TOLERANZ): MatchAmpel {
  const diff = Math.abs(gebucht - erfasst);
  if (diff <= toleranz + 0.005) return 'gruen';
  const basis = Math.max(Math.abs(erfasst), Math.abs(gebucht));
  if (basis <= 0) return 'gruen';
  if (diff / basis < 0.05) return 'gelb';
  return 'rot';
}

// ─── Automatisches Matching ──────────────────────────────────────────────────

/** Datum → Tage seit Epoche (Rechnungen ISO, Buchungen dd.mm.yyyy); NaN-sicher. */
function tagIndex(datum: string): number | null {
  let iso = datum ?? '';
  const ch = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(iso);
  if (ch) iso = `${ch[3]}-${ch[2]}-${ch[1]}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) ? Math.round(t / 86_400_000) : null;
}

function datumDistanz(a: string, b: string): number {
  const ta = tagIndex(a), tb = tagIndex(b);
  return ta !== null && tb !== null ? Math.abs(ta - tb) : 9_999; // unbekannt = schlechtester Tiebreaker
}

/** Kombinationen (Indizes) der Grösse 2..maxK — Suchraum bewusst klein halten. */
function* kombinationen(n: number, maxK: number): Generator<number[]> {
  const idx: number[] = [];
  function* rec(start: number, k: number): Generator<number[]> {
    if (idx.length === k) { yield [...idx]; return; }
    for (let i = start; i < n; i++) { idx.push(i); yield* rec(i + 1, k); idx.pop(); }
  }
  for (let k = 2; k <= maxK; k++) yield* rec(0, k);
}

export interface AutoMatchInput {
  invoices: InvoiceEntry[];
  buchungen: SageJournalEntry[];
  /** buchungKeysMitIndex(buchungen). */
  keys: string[];
  /** Bestehender Zustand: gematcht + gesperrt wird NIE angefasst. */
  state: FibuMatchState;
  /** Absolute CHF-Toleranz (Default 10.00). */
  toleranz?: number;
}

/**
 * Automatische Match-Vorschläge — NUR eindeutige Zuordnungen:
 *  a) exakte 1:1 innerhalb Toleranz zuerst (beidseitig bester Kandidat;
 *     Tiebreaker Datumsnähe; bei Gleichstand mehrdeutig → offen lassen),
 *  b) danach kleine Kombinationen (2–4 Rechnungen ≈ 1 Buchung bzw.
 *     2–4 Buchungen ≈ 1 Rechnung): kleinste Differenz gewinnt; passen mehrere
 *     Kombinationen mit gleicher Differenz, entscheidet BEWUSST die
 *     Datumsnähe als Tiebreaker (Produktregel, Spez. 3c); nur bei gleicher
 *     Differenz UND gleicher Datumsnähe ist es mehrdeutig → offen lassen.
 * Bereits gematchte und gesperrte Zeilen werden nie berührt. Rein zuordnend —
 * keine Beträge werden verändert. Rückgabe: NEUE Gruppen (herkunft 'auto').
 */
export function autoMatchVorschlaege(input: AutoMatchInput): FibuMatchGruppe[] {
  const tol = (input.toleranz ?? DEFAULT_FIBU_MATCH_TOLERANZ) + 0.005; // Rappen-Rundung
  const belegtInv = new Set([
    ...input.state.gruppen.flatMap(g => g.invoiceIds),
    ...input.state.gesperrt.invoiceIds,
  ]);
  const belegtKey = new Set([
    ...input.state.gruppen.flatMap(g => g.buchungKeys),
    ...input.state.gesperrt.buchungKeys,
  ]);
  // Offene Positionen (Reihenfolge beibehalten für Determinismus).
  const inv = input.invoices.map((e, i) => ({ e, i })).filter(x => !belegtInv.has(x.e.id));
  const buch = input.buchungen.map((b, i) => ({ b, key: input.keys[i] })).filter(x => !belegtKey.has(x.key));

  const neu: FibuMatchGruppe[] = [];
  let seq = 0;
  const nimm = (invoiceIds: string[], buchungKeys: string[]) => {
    neu.push({ id: `auto-${Date.now()}-${seq++}`, invoiceIds, buchungKeys, herkunft: 'auto' });
    for (const id of invoiceIds) belegtInv.add(id);
    for (const k of buchungKeys) belegtKey.add(k);
  };

  // ── Phase a: eindeutige 1:1 ──
  // Kandidatenpaare mit Score (Differenz, Datumsdistanz), aufsteigend sortiert.
  type Paar = { invId: string; key: string; diff: number; dist: number };
  const paare: Paar[] = [];
  for (const { e } of inv) {
    for (const { b, key } of buch) {
      const diff = Math.abs(buchungBetrag(b) - e.amountNet);
      if (diff <= tol) paare.push({ invId: e.id, key, diff, dist: datumDistanz(e.date, b.date) });
    }
  }
  paare.sort((a, b) => a.diff - b.diff || a.dist - b.dist);
  for (let i = 0; i < paare.length; i++) {
    const p = paare[i];
    if (belegtInv.has(p.invId) || belegtKey.has(p.key)) continue;
    // Mehrdeutig? Ein anderes noch freies Paar mit identischem Score, das
    // dieselbe Rechnung ODER Buchung beansprucht → beide offen lassen.
    const konkurrent = paare.some((q, j) => j !== i
      && !(belegtInv.has(q.invId) || belegtKey.has(q.key))
      && (q.invId === p.invId || q.key === p.key)
      && q.diff === p.diff && q.dist === p.dist);
    if (konkurrent) continue;
    nimm([p.invId], [p.key]);
  }

  // ── Phase b: kleine Kombinationen (Suchraum begrenzen: max. 12 offene Positionen je Seite) ──
  const MAX_POS = 12, MAX_K = 4;
  const kombiSeite = (
    ziele: Array<{ id: string; betrag: number; datum: string }>,
    teile: Array<{ id: string; betrag: number; datum: string }>,
    macheGruppe: (zielId: string, teilIds: string[]) => void,
  ) => {
    if (teile.length > MAX_POS) return; // zu viele offene Positionen → nur manuell
    for (const ziel of ziele) {
      if (belegtInv.has(ziel.id) || belegtKey.has(ziel.id)) continue;
      const frei = teile.filter(t => !belegtInv.has(t.id) && !belegtKey.has(t.id));
      let best: { ids: string[]; diff: number; dist: number } | null = null;
      let gleichGut = 0; // Anzahl gleich guter Kombinationen (>1 = mehrdeutig)
      for (const combo of kombinationen(frei.length, Math.min(MAX_K, frei.length))) {
        const sum = combo.reduce((s, ci) => s + frei[ci].betrag, 0);
        const diff = Math.abs(ziel.betrag - sum);
        if (diff > tol) continue;
        const dist = Math.max(...combo.map(ci => datumDistanz(ziel.datum, frei[ci].datum)));
        if (!best || diff < best.diff || (diff === best.diff && dist < best.dist)) {
          best = { ids: combo.map(ci => frei[ci].id), diff, dist };
          gleichGut = 1;
        } else if (diff === best.diff && dist === best.dist) {
          gleichGut += 1; // zweite gleich gute Kombination → offen lassen
        }
      }
      if (best && gleichGut === 1) macheGruppe(ziel.id, best.ids);
    }
  };
  // 2–4 Rechnungen ≈ 1 Buchung
  kombiSeite(
    buch.filter(x => !belegtKey.has(x.key)).map(x => ({ id: x.key, betrag: buchungBetrag(x.b), datum: x.b.date })),
    inv.filter(x => !belegtInv.has(x.e.id)).map(x => ({ id: x.e.id, betrag: x.e.amountNet, datum: x.e.date })),
    (zielKey, invoiceIds) => nimm(invoiceIds, [zielKey]),
  );
  // 2–4 Buchungen ≈ 1 Rechnung
  kombiSeite(
    inv.filter(x => !belegtInv.has(x.e.id)).map(x => ({ id: x.e.id, betrag: x.e.amountNet, datum: x.e.date })),
    buch.filter(x => !belegtKey.has(x.key)).map(x => ({ id: x.key, betrag: buchungBetrag(x.b), datum: x.b.date })),
    (zielInvId, buchungKeys) => nimm([zielInvId], buchungKeys),
  );

  return neu;
}

export interface LieferantMatchStat {
  matchedInvoices: number; totalInvoices: number;
  matchedBuchungen: number; totalBuchungen: number;
  /** Ungematchte Summen — die noch ungeklärte Differenz. */
  offenErfasst: number; offenGebucht: number;
}

/**
 * Match-State gegen die noch existierenden Rechnungs-IDs bereinigen (pur):
 * verwaiste invoiceIds aus Gruppen und Sperrliste entfernen. Eine Match-
 * Gruppe braucht BEIDE Seiten — bleibt keine Rechnung ODER keine Buchung
 * übrig, wird die ganze Gruppe entfernt (die Gegenseite erscheint danach
 * korrekt als «offen» statt fälschlich «gematcht»). Die Sperrliste wird nur
 * um verwaiste Invoice-IDs bereinigt (Buchungs-Sperren bleiben stehen).
 */
export function bereinigeMatchState(
  state: FibuMatchState,
  gueltigeInvoiceIds: ReadonlySet<string>,
): { state: FibuMatchState; geaendert: boolean } {
  const gruppen = state.gruppen
    .map(g => ({ ...g, invoiceIds: g.invoiceIds.filter(id => gueltigeInvoiceIds.has(id)) }))
    .filter(g => g.invoiceIds.length > 0 && g.buchungKeys.length > 0);
  const gesperrtInv = state.gesperrt.invoiceIds.filter(id => gueltigeInvoiceIds.has(id));
  const geaendert = gruppen.length !== state.gruppen.length
    || gesperrtInv.length !== state.gesperrt.invoiceIds.length
    || gruppen.some((g, i) => g.invoiceIds.length !== state.gruppen[i].invoiceIds.length);
  return {
    state: { gruppen, gesperrt: { ...state.gesperrt, invoiceIds: gesperrtInv } },
    geaendert,
  };
}

/**
 * Übersicht je Lieferant: wie viel ist gematcht, was ist noch offen.
 * `invoices`/`buchungen` sind die im Drilldown angezeigten Listen des
 * (ggf. alias-gruppierten) Lieferanten; `keys` = buchungKeysMitIndex(buchungen).
 */
export function lieferantMatchStat(
  invoices: InvoiceEntry[],
  buchungen: SageJournalEntry[],
  keys: string[],
  gruppen: FibuMatchGruppe[],
): LieferantMatchStat {
  const matchedInv = new Set(gruppen.flatMap(g => g.invoiceIds));
  const matchedKey = new Set(gruppen.flatMap(g => g.buchungKeys));
  let matchedInvoices = 0, offenErfasst = 0;
  for (const inv of invoices) {
    if (matchedInv.has(inv.id)) matchedInvoices += 1;
    else offenErfasst += inv.amountNet;
  }
  let matchedBuchungen = 0, offenGebucht = 0;
  buchungen.forEach((b, i) => {
    if (matchedKey.has(keys[i])) matchedBuchungen += 1;
    else offenGebucht += buchungBetrag(b);
  });
  return {
    matchedInvoices, totalInvoices: invoices.length,
    matchedBuchungen, totalBuchungen: buchungen.length,
    offenErfasst, offenGebucht,
  };
}
