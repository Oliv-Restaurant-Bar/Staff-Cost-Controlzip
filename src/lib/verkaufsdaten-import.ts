/**
 * verkaufsdaten-import.ts — Gastronovi Food/Beverage-Jahresexport (Artikel)
 * =========================================================================
 * Parst die vier Gastronovi-Artikel-Exporte pro Jahr (Food-Umsatz, Food-Anzahl,
 * Beverage-Umsatz, Beverage-Anzahl) und speist daraus AUSSCHLIESSLICH:
 *  - die Cockpit-Zeile «Gäste Take Away» (Σ verkaufte Einheiten aller
 *    TA-Artikel, 1 Einheit = 1 Gast — daraus auch der Take-Away-Anteil), und
 *  - das Archiv `verkaufszahlen_{jahr}` (Vorschau-/Diff-Basis).
 * Die Cockpit-Zeilen Food/Beverage kommen NICHT von hier — sie stammen
 * ausschliesslich aus dem Umsatz-Excel (dailyBudgets → umsatz.ts-Split,
 * Invariante Food+Beverage=Netto). Artikel-Umsätze/-Anzahlen für die
 * Produktanalyse laufen über den separaten Produkte-Import (product_sales).
 *
 * FORMAT (an echten Dateien verankert):
 *  - Tab-getrennt (\t), UTF-8. Kopf: «Bezeichnung», «Zeitraum» (Periodentotal),
 *    danach Tagesspalten «01.01.» … «31.12.» (Jahr kommt aus dem Jahr-Dropdown).
 *  - Erste Datenzeile «Gesamt - Food (Speisen)» bzw. «Gesamt - Beverage
 *    (Getränke)» = Tagestotale; darunter Artikelzeilen (werden ignoriert).
 *  - Umsatz-Werte im Format «CHF 1873993,50» (CHF-Präfix, Komma = Dezimal);
 *    Anzahl-Dateien analog ohne CHF (Stück).
 *
 * SPEICHERZIELE (Datenquellen-Trennung seit 08/2026 — dailyBudgets und
 * vj_daily werden hier NICHT mehr geschrieben):
 *  - `ta-gaeste-daily` (tenant-präfixiert): «Gäste Take Away» pro Tag aus den
 *    Anzahl-Dateien (nur wenn TA-Artikel vorhanden).
 *  - Archiv-Blob `verkaufszahlen_{jahr}` (tenant-präfixiert): Umsatz UND Anzahl
 *    je Tag/Kategorie — Basis der Vorschau «neu/aktualisiert/unverändert».
 *
 * Diagnostik-Regel (gn-parser-diagnostics): Der Parser liefert auf ALLEN Pfaden
 * ein debug-Objekt + failureReason — nie blind an ein geratenes Format anpassen.
 */


// ── Typen ─────────────────────────────────────────────────────────────────────

export type VkCategory = 'food' | 'beverage';
export type VkKind = 'umsatz' | 'anzahl';

export interface VkParsedFile {
  ok: boolean;
  failureReason?: string;
  category: VkCategory | null;
  kind: VkKind | null;
  /** Tageswerte 'MM-DD' → Wert (>0). */
  days: Record<string, number>;
  /** Periodentotal aus der «Zeitraum»-Spalte der Gesamt-Zeile (Kontrollwert). */
  periodTotal: number | null;
  fileName: string;
  /**
   * NUR Anzahl-Dateien mit ≥1 Take-Away-Artikelzeile: Σ Einheiten aller
   * TA-Artikel je Tag ('MM-DD'; 1 Einheit = 1 TA-Gast). Gelieferte Tage der
   * Gesamt-Zeile ohne TA-Verkauf stehen als explizite 0 drin. undefined =
   * keine TA-Artikel in der Datei (z.B. Beaulieu) → nichts überschreiben.
   */
  taGuests?: Record<string, number>;
  /** Σ der «Zeitraum»-Spalte aller TA-Artikelzeilen (Kontrollwert). */
  taGuestsPeriodTotal?: number | null;
  /** Anzahl erkannter TA-Artikelzeilen (Diagnose/Vorschau). */
  taArticleCount?: number;
  /** Diagnose: echte Dateistruktur bei Fehlern sichtbar machen. */
  debug: { headerPreview: string; gesamtCell: string | null; dayColumns: number; dataRows: number };
}

/** Ein Tag im Archiv-Blob: Umsatz (brutto) und Anzahl je Kategorie. */
export interface VkDay {
  foodRevenue?: number;
  foodCount?: number;
  beverageRevenue?: number;
  beverageCount?: number;
  /** «Gäste Take Away»: Σ Einheiten aller TA-Artikel (Food + Beverage). */
  taGuests?: number;
}

export interface VkBlob {
  days: Record<string, VkDay>; // 'YYYY-MM-DD' → VkDay
  updatedAt: string;
}

export const verkaufszahlenKey = (year: number) => `verkaufszahlen_${year}`;

// ── Take-Away-Artikelerkennung ────────────────────────────────────────────────

/**
 * Streng, keine False Positives: Der Artikelname enthält «TA» als
 * EIGENSTÄNDIGES Wort in GROSSBUCHSTABEN (nicht angrenzend an Buchstaben/
 * Ziffern — «Ricotta», «Vegetaria», «Tagesmenu», «RICOTTA» matchen NIE) ODER
 * «Take Away»/«Take-Away»/«Takeaway» (Gross-/Kleinschreibung egal).
 */
const TA_WORD_REGEX = /(?<![\p{L}\p{N}])TA(?![\p{L}\p{N}])/u;
const TAKE_AWAY_REGEX = /take[\s-]?away/i;

export function isTakeAwayArticleName(name: string | null | undefined): boolean {
  if (!name) return false;
  return TA_WORD_REGEX.test(name) || TAKE_AWAY_REGEX.test(name);
}

// ── Parser ────────────────────────────────────────────────────────────────────

/**
 * Zerlegt eine TSV-Zeile in Zellen und entfernt je Zelle umschliessende
 * doppelte Anführungszeichen + Leerzeichen — die Gastronovi-Exporte liefern
 * JEDE Zelle gequotet («"01.01."», «"CHF 1467326,80"»). Muss VOR der
 * Tagesspalten-/Gesamt-Erkennung passieren.
 */
function splitTsvCells(line: string): string[] {
  return line.split('\t').map(c => {
    const t = c.trim();
    return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).trim() : t;
  });
}

/** «CHF 1873993,50» / «"CHF 1467326,80"» / «1'234,5» / «317» → Zahl; ungültig → null. */
export function parseVkNumber(raw: string): number | null {
  let s = raw.replace(/CHF/gi, '').replace(/[\u00A0\u2019'"\s]/g, '').trim();
  if (s === '' || s === '-') return null;
  // Komma = Dezimaltrennzeichen; Punkte davor sind Tausendertrenner.
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parst EINE Exportdatei. Kategorie/Typ werden aus dem Inhalt erkannt
 * («Gesamt - Food …» / «Gesamt - Beverage …», CHF-Präfix = Umsatz) —
 * der Dateiname dient nur als Fallback.
 */
export function parseVerkaufsdatenFile(text: string, fileName: string): VkParsedFile {
  const fail = (reason: string, dbg?: Partial<VkParsedFile['debug']>): VkParsedFile => ({
    ok: false, failureReason: reason, category: null, kind: null, days: {},
    periodTotal: null, fileName,
    debug: { headerPreview: '', gesamtCell: null, dayColumns: 0, dataRows: 0, ...dbg },
  });

  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length < 2) return fail('Datei enthält keine Datenzeilen.');

  const header = splitTsvCells(lines[0]);
  const headerPreview = header.slice(0, 5).join(' | ');
  if (header.length < 3) {
    return fail('Kopfzeile ist nicht Tab-getrennt (erwartet: «Bezeichnung», «Zeitraum», Tagesspalten «01.01.» …).', { headerPreview });
  }

  // Tagesspalten «01.01.» … «31.12.» → 'MM-DD' — mit ODER ohne End-Punkt,
  // ohne Jahr (das Jahr kommt aus dem Dropdown).
  const dayCols: Array<{ idx: number; md: string }> = [];
  header.forEach((h, idx) => {
    const m = /^(\d{2})\.(\d{2})\.?$/.exec(h);
    if (m) dayCols.push({ idx, md: `${m[2]}-${m[1]}` });
  });
  const zeitraumIdx = header.findIndex(h => /zeitraum/i.test(h));
  if (dayCols.length === 0) {
    return fail(`Keine Tagesspalten («01.01.» …) im Kopf gefunden. Kopf: ${headerPreview}`, { headerPreview });
  }

  // Erste Datenzeile «Gesamt - …» = Tagestotale
  const gesamtLine = lines.slice(1).find(l => /^\s*gesamt\b/i.test(splitTsvCells(l)[0] ?? ''));
  if (!gesamtLine) {
    return fail('Keine «Gesamt - …»-Zeile gefunden (erste Datenzeile mit den Tagestotalen).',
      { headerPreview, dayColumns: dayCols.length, dataRows: lines.length - 1 });
  }
  const cells = splitTsvCells(gesamtLine);
  const gesamtCell = (cells[0] ?? '').trim();

  // Kategorie: Inhalt vor Dateiname
  const catFrom = (s: string): VkCategory | null =>
    /food|speisen/i.test(s) ? 'food' : /beverage|getr(ä|ae)nke/i.test(s) ? 'beverage' : null;
  const category = catFrom(gesamtCell) ?? catFrom(fileName);
  if (!category) {
    return fail(`Kategorie (Food/Beverage) nicht erkennbar — Gesamt-Zeile: «${gesamtCell}».`,
      { headerPreview, gesamtCell, dayColumns: dayCols.length, dataRows: lines.length - 1 });
  }

  // Typ: CHF-Präfix in der Gesamt-Zeile = Umsatz; sonst Anzahl (Dateiname als Fallback-Hinweis)
  const hasChf = cells.some(c => /CHF/i.test(c));
  const kind: VkKind = hasChf ? 'umsatz' : /umsatz/i.test(fileName) && !/anzahl|st(ü|ue)ck/i.test(fileName) ? 'umsatz' : 'anzahl';

  // Explizite 0 ist ein echter Tageswert (ersetzt beim Re-Import alte Werte);
  // nur LEERE Zellen bedeuten «nicht geliefert» und werden übersprungen.
  const days: Record<string, number> = {};
  for (const { idx, md } of dayCols) {
    const v = parseVkNumber(cells[idx] ?? '');
    if (v !== null) days[md] = v;
  }
  const periodTotal = zeitraumIdx >= 0 ? parseVkNumber(cells[zeitraumIdx] ?? '') : null;

  if (Object.keys(days).length === 0) {
    return fail('Gesamt-Zeile enthält keine Tageswerte.',
      { headerPreview, gesamtCell, dayColumns: dayCols.length, dataRows: lines.length - 1 });
  }

  // ── Take-Away-Gäste (nur Anzahl-Dateien): Artikelzeilen scannen ─────────────
  // Jede verkaufte Einheit eines TA-Artikels = 1 TA-Gast. Die «Gesamt»-Zeile
  // wird ignoriert; nur Artikelzeilen zählen. Keine TA-Artikel in der Datei
  // (z.B. Beaulieu) → taGuests bleibt undefined (nichts wird überschrieben).
  let taGuests: Record<string, number> | undefined;
  let taGuestsPeriodTotal: number | null = null;
  let taArticleCount = 0;
  if (kind === 'anzahl') {
    const taByDay: Record<string, number> = {};
    for (const line of lines.slice(1)) {
      if (line === gesamtLine) continue;
      const rowCells = splitTsvCells(line);
      const label = (rowCells[0] ?? '').trim();
      if (!label || /^\s*gesamt\b/i.test(label)) continue; // Gesamt-Zeile(n) ignorieren
      if (!isTakeAwayArticleName(label)) continue;
      taArticleCount++;
      for (const { idx, md } of dayCols) {
        const v = parseVkNumber(rowCells[idx] ?? '');
        if (v !== null && v > 0) taByDay[md] = (taByDay[md] ?? 0) + v;
      }
      if (zeitraumIdx >= 0) {
        const zt = parseVkNumber(rowCells[zeitraumIdx] ?? '');
        if (zt !== null) taGuestsPeriodTotal = (taGuestsPeriodTotal ?? 0) + zt;
      }
    }
    if (taArticleCount > 0) {
      // Gelieferte Tage (Gesamt-Zeile) ohne TA-Verkauf = explizite 0 —
      // ersetzt beim Re-Import einen allfälligen alten Tageswert.
      taGuests = {};
      for (const md of Object.keys(days)) taGuests[md] = 0;
      for (const [md, v] of Object.entries(taByDay)) taGuests[md] = v;
    }
  }

  return {
    ok: true, category, kind, days, periodTotal, fileName,
    ...(taGuests !== undefined ? { taGuests, taGuestsPeriodTotal, taArticleCount } : {}),
    debug: { headerPreview, gesamtCell, dayColumns: dayCols.length, dataRows: lines.length - 1 },
  };
}

// ── Zusammenführung + Vorschau ────────────────────────────────────────────────

export interface VkPlan {
  /** Vollständige Tagesdaten 'YYYY-MM-DD' → VkDay (Union aller Dateien). */
  days: Record<string, VkDay>;
  neu: number;
  aktualisiert: number;
  unveraendert: number;
}

/** Feld je Datei-Typ. */
const fieldFor = (category: VkCategory, kind: VkKind): keyof VkDay =>
  kind === 'umsatz'
    ? (category === 'food' ? 'foodRevenue' : 'beverageRevenue')
    : (category === 'food' ? 'foodCount' : 'beverageCount');

/**
 * Baut den Import-Plan: vereinigt die Dateien zu Tagesrecords des gewählten
 * Jahres und vergleicht mit dem bestehenden Archiv (neu/aktualisiert/
 * unverändert je Tag; Vergleich feldweise auf 2 Rappen genau).
 */
export function buildVkPlan(year: number, files: VkParsedFile[], existing: Record<string, VkDay>): VkPlan {
  const days: Record<string, VkDay> = {};
  for (const f of files) {
    if (!f.ok || !f.category || !f.kind) continue;
    const field = fieldFor(f.category, f.kind);
    for (const [md, v] of Object.entries(f.days)) {
      const date = `${year}-${md}`;
      (days[date] ??= {})[field] = v;
    }
    // TA-Gäste: Food- und Beverage-Anzahl ADDIEREN sich (beide Dateien können
    // TA-Artikel enthalten; Beverage meist ~0).
    if (f.taGuests) {
      for (const [md, v] of Object.entries(f.taGuests)) {
        const date = `${year}-${md}`;
        const rec = (days[date] ??= {});
        rec.taGuests = (rec.taGuests ?? 0) + v;
      }
    }
  }
  let neu = 0, aktualisiert = 0, unveraendert = 0;
  const eq = (a?: number, b?: number) =>
    (a === undefined && b === undefined) || (a !== undefined && b !== undefined && Math.abs(a - b) < 0.005);
  for (const [date, rec] of Object.entries(days)) {
    const prev = existing[date];
    if (!prev) { neu++; continue; }
    // Nur die Felder vergleichen, die der Import mitbringt (Teil-Import
    // aktualisiert bestehende andere Felder nicht → nicht als Änderung werten).
    const changed = (Object.keys(rec) as Array<keyof VkDay>).some(k => !eq(rec[k], prev[k]));
    if (changed) aktualisiert++; else unveraendert++;
  }
  return { days, neu, aktualisiert, unveraendert };
}

// ── Commit ────────────────────────────────────────────────────────────────────

export interface VkCommitResult {
  /** Alle geschriebenen Archiv-Tage. */
  archivedDays: number;
  /** Tage mit «Gäste Take Away»-Werten → ta-gaeste-daily-Updates. */
  taGuestDays: number;
}

/**
 * Schreibt den Plan: Archiv-Blob (Merge) und «Gäste Take Away»
 * (ta-gaeste-daily, Merge je Datum). dailyBudgets und vj_daily werden
 * BEWUSST NICHT angefasst — die Cockpit-Zeilen Food/Beverage kommen
 * ausschliesslich aus dem Umsatz-Excel (Datenquellen-Trennung 08/2026).
 *
 * JAHRES-SPERRE: gilt hier BEWUSST NICHT (User-Entscheid 08/2026) — der Import
 * berührt keine festgeschriebenen Umsatz-/Kosten-/Cockpit-Daten, nur das
 * Verkaufszahlen-Archiv und «Gäste Take Away». Die Sperre bleibt für alle
 * Umsatz-/Kosten-/Cockpit-Importe unverändert bestehen.
 */
export async function commitVerkaufsdaten(opts: {
  /** tenant-präfixierter Archiv-Key (tenantKey(verkaufszahlenKey(year))). */
  archiveKey: string;
  /** tenant-präfixierter «Gäste Take Away»-Key (tenantKey('ta-gaeste-daily')). */
  taGaesteKey?: string;
  plan: VkPlan;
}): Promise<VkCommitResult> {
  const { plan } = opts;

  const { kvGetStrict, kvSetStrict } = await import('@/lib/supabase-kv');

  // ── 0) «Gäste Take Away»-Merge-Basis STRIKT lesen — VOR dem ersten Write,
  // damit ein Lesefehler keinen teilweise ausgeführten Import (Archiv
  // geschrieben, TA nicht) hinterlässt.
  const taIncoming: Record<string, number> = {};
  for (const [date, rec] of Object.entries(plan.days)) {
    if (rec.taGuests !== undefined) taIncoming[date] = rec.taGuests;
  }
  const writeTa = Boolean(opts.taGaesteKey) && Object.keys(taIncoming).length > 0;
  const taStore = writeTa ? await import('@/lib/ta-gaeste-store') : null;
  const taBase = writeTa && taStore
    ? await taStore.readTaGaesteBaseStrict(opts.taGaesteKey!)
    : {};

  // ── 1) Archiv-Blob: Merge-Basis STRIKT lesen (Lesefehler ≠ leer) ──
  const prevBlob = (await kvGetStrict(opts.archiveKey)) as VkBlob | null;
  const mergedDays: Record<string, VkDay> = { ...(prevBlob?.days ?? {}) };
  for (const [date, rec] of Object.entries(plan.days)) {
    mergedDays[date] = { ...(mergedDays[date] ?? {}), ...rec };
  }
  await kvSetStrict(opts.archiveKey, { days: mergedDays, updatedAt: new Date().toISOString() } satisfies VkBlob);

  // ── 2) «Gäste Take Away»: Tageswerte in den ta-gaeste-daily-Store ──
  // Merge je Datum (gleiche Tage ersetzt, nie addiert; andere Jahre/Tage
  // bleiben erhalten — Merge-Basis wurde in 0b STRIKT gelesen). Keine
  // TA-Artikel in den Dateien (Beaulieu) → nichts geschrieben.
  let taGuestDays = 0;
  if (writeTa && taStore) {
    await taStore.writeTaGaesteMerged(opts.taGaesteKey!, taBase, taIncoming);
    taGuestDays = Object.keys(taIncoming).length;
  }

  return { archivedDays: Object.keys(plan.days).length, taGuestDays };
}
