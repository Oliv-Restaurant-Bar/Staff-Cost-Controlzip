/**
 * Warenrechnungen ↔ Buchhaltung — Abgleich pro Lieferant (Teil B).
 *
 * Pure Logik (node-testbar). Datenquellen:
 *  - erfasst: InvoiceEntry[] des Monats (Warenrechnungen-Erfassung)
 *  - gebucht: SageJournalEntry[] («Ist Kosten Buchhaltung»-Import mit
 *    Buchungszeilen inkl. Buchungstext) — gefiltert auf die Warenkonten.
 *
 * DEGRADATION: Liegen für den Monat KEINE Buchungszeilen vor (z.B. nur der
 * Jahres-Kontoblatt-Import, der Buchungstexte verwirft, oder Mandant ohne
 * Journal), wird sauber degradiert: nur «erfasst total» vs. «Buchhaltung/ER
 * total» (aus computePLForMonth total_cogs) mit Differenz; pro Lieferant
 * steht «keine Buchhaltungsdaten» — es wird NIE ein Fehler geworfen.
 */

import type { InvoiceEntry } from '@/lib/waren-db';
import type { SageJournalEntry } from '@/types/reporting';
import { findSupplierInText, type SupplierAliasMap } from '@/lib/waren-pdf-erkennung';
import { buildAliasResolver, type AliasGruppe } from '@/lib/waren-alias-gruppen';

export type AbgleichStatus =
  | 'ok'            // beide Quellen, Differenz unter Schwelle
  | 'abweichung'    // beide Quellen, Differenz über Schwelle → rot
  | 'nur-erfasst'   // Rechnung erfasst, keine Buchung gefunden → auffällig
  | 'nur-gebucht'   // Buchung vorhanden, keine Erfassung → auffällig
  | 'keine-fibu';   // degradiert: keine Buchhaltungsdaten auf Lieferanten-Ebene

export interface AbgleichZeile {
  lieferant: string;
  erfasst: number | null;   // CHF netto aus Warenrechnungen
  gebucht: number | null;   // CHF aus Buchungszeilen (Soll − Haben)
  diff: number | null;      // gebucht − erfasst (nur wenn beide vorhanden)
  status: AbgleichStatus;
  /** Anzahl erfasster Rechnungen bzw. zugeordneter Buchungen (Drilldown-Basis). */
  anzahlRechnungen: number;
  anzahlBuchungen: number;
  /** Zugeordnete Buchungszeilen (Drilldown, leer im degradierten Modus). */
  buchungen: SageJournalEntry[];
  /**
   * Transparenz bei Alias-Gruppen: Original-Namen mit ihren Beträgen
   * (Erfasst/Buchhaltung je Alias). Nur gesetzt, wenn die Zeile aus einer
   * Alias-Gruppe zusammengeführt wurde.
   */
  mitglieder?: Array<{ name: string; erfasst: number | null; gebucht: number | null }>;
}

export interface WarenAbgleich {
  /** 'lieferanten' = Buchungszeilen vorhanden; 'nur-total' = degradiert. */
  mode: 'lieferanten' | 'nur-total';
  zeilen: AbgleichZeile[];
  erfasstTotal: number;
  /** Buchhaltungs-Total: Journal-Summe bzw. im degradierten Modus ER-total_cogs. */
  gebuchtTotal: number | null;
  diffTotal: number | null;
  /** Buchungen auf Warenkonten ohne Lieferanten-Zuordnung (nur mode=lieferanten). */
  nichtZugeordnet: SageJournalEntry[];
  nichtZugeordnetSumme: number;
  /**
   * Tatsächlich verwendete Alias-Gruppen: abgeleitete Barausgaben-Standard-
   * Aliasse + Nutzer-Gruppen (Nutzer gewinnt). Die UI MUSS für Drilldown-/
   * Rechnungs-Filter einen Resolver aus DIESEN Gruppen bauen, sonst sehen
   * Barausgaben-Zeilen ihre erfassten Rechnungen («Migros») nicht.
   */
  effektiveAliasGruppen: AliasGruppe[];
}

/** Betrag einer Buchungszeile: Aufwandskonto → Soll − Haben. */
export function buchungsBetrag(e: SageJournalEntry): number {
  if (e.soll || e.haben) return (e.soll ?? 0) - (e.haben ?? 0);
  return e.amount ?? 0;
}

/**
 * MANDANTEN-SCHUTZ: Die Journal-KV-Schlüssel sind mandantenfähig —
 * Oliv historisch OHNE Präfix (`sage_journal_v1_*`, alle Alt-Importe stammen
 * aus der Oliv-Buchhaltung), andere Mandanten mit Tenant-Präfix
 * (`beaulieu:sage_journal_v1_*`, siehe reporting-store.journalMonthKey).
 * Dadurch ist das Journal jetzt auch für Beaulieu nutzbar; unbekannte
 * Mandanten bleiben im degradierten Modus (nur Total-Vergleich).
 */
export function journalVerfuegbarFuerTenant(tenantId: string): boolean {
  return tenantId === 'oliv' || tenantId === 'beaulieu';
}

// ─── Barausgaben (Bar-/Kasseneinkäufe auf Warenkonten) ──────────────────────

/**
 * Kanonischer Barausgaben-Lieferant aus einem Buchungstext: Texte, die
 * (case-insensitive) mit «Barausgabe»/«Barausgaben» beginnen, werden als
 * eigener Lieferant «Barausgaben <Laden>» geführt (Laden = Rest des Textes,
 * z.B. «Barausgabe Migros» → «Barausgaben Migros»). Ladenunabhängig — nur
 * das Präfix zählt; ohne Laden-Rest bleibt es beim generischen «Barausgaben».
 */
export function barausgabenLieferant(text: string | null | undefined): string | null {
  const t = (text ?? '').trim();
  const m = /^barausgaben?\b[\s:,\-–]*/i.exec(t);
  if (!m) return null;
  const laden = t.slice(m[0].length).trim().replace(/\s+/g, ' ');
  return laden ? `Barausgaben ${laden}` : 'Barausgaben';
}

/**
 * Implizite Standard-Alias-Gruppen für die im Journal gefundenen Barausgaben-
 * Läden, damit bereits ERFASSTE Schreibweisen («Migros», «Barausgabe Migros»)
 * mit der Buchhaltungs-Zeile «Barausgaben Migros» matchen und nicht fälschlich
 * als «fehlt» erscheinen. Die Gruppen werden VOR den mandanten-editierbaren
 * Alias-Gruppen einsortiert — beim Resolver gewinnt der letzte Eintrag,
 * d.h. eine vom Nutzer gespeicherte Gruppe überstimmt die Standard-Aliasse.
 */
export function barausgabenAliasGruppen(journal: SageJournalEntry[]): AliasGruppe[] {
  const laeden = new Map<string, string>(); // kanonisch → Laden
  for (const e of journal) {
    const canon = barausgabenLieferant(e.text);
    if (!canon || canon === 'Barausgaben') continue;
    laeden.set(canon, canon.slice('Barausgaben '.length));
  }
  return [...laeden.entries()].map(([canon, laden]) => ({
    id: `grp-barausgaben-${laden.toLowerCase().replace(/\s+/g, '-')}`,
    name: canon,
    aliases: [laden, `Barausgabe ${laden}`],
  }));
}

export interface AbgleichInput {
  invoices: InvoiceEntry[];
  /** Buchungszeilen des Monats; leer/null → degradierter Modus. */
  journal: SageJournalEntry[] | null;
  /** Warenkonto-Nummern (z.B. ['4000','4020',…]) zum Filtern des Journals. */
  warenkontoNummern: string[];
  supplierNames: string[];
  aliases: SupplierAliasMap;
  /** ER-/Kontoblatt-Total (total_cogs) für den degradierten Modus. */
  buchhaltungTotal: number | null;
  /** Rote Markierung ab dieser absoluten Differenz (CHF). Default 50. */
  schwelleChf?: number;
  /**
   * Alias-Gruppen (mandantengetrennt): Erfasst UND Buchhaltung werden pro
   * kanonischem Gruppennamen über alle Aliasse SUMMIERT und in EINER Zeile
   * gezeigt. Reine Anzeige-/Abgleich-Gruppierung — Beträge unverändert.
   */
  aliasGruppen?: AliasGruppe[];
}

export function buildWarenAbgleich(input: AbgleichInput): WarenAbgleich {
  const schwelle = input.schwelleChf ?? 50;
  // ── Journal auf Warenkonten filtern (früh — Barausgaben-Aliasse hängen dran) ──
  const kontoSet = new Set(input.warenkontoNummern);
  const warenBuchungen = (input.journal ?? []).filter(e =>
    kontoSet.has(String(e.accountNumber).replace(/^0+/, '')) || kontoSet.has(String(e.accountNumber)));

  // Alias-Gruppen: Namen beider Quellen auf den kanonischen Gruppennamen
  // abbilden; Original-Namen je Zeile für die Transparenz mitführen.
  // Barausgaben-Standard-Aliasse ZUERST — Nutzer-Gruppen (später gesetzt)
  // gewinnen im Resolver (letzter set() pro Schlüssel).
  const effektiveGruppen = [
    ...barausgabenAliasGruppen(warenBuchungen),
    ...(input.aliasGruppen ?? []),
  ];
  const resolve = buildAliasResolver(effektiveGruppen);
  const originaleErfasst = new Map<string, Map<string, number>>(); // kanonisch → Original → Summe
  const originaleGebucht = new Map<string, Map<string, number>>();
  const addOriginal = (m: Map<string, Map<string, number>>, canon: string, orig: string, betrag: number) => {
    const inner = m.get(canon) ?? new Map<string, number>();
    inner.set(orig, (inner.get(orig) ?? 0) + betrag);
    m.set(canon, inner);
  };

  // ── erfasst je Lieferant (kanonisiert) ──
  const erfasstMap = new Map<string, { sum: number; count: number }>();
  for (const inv of input.invoices) {
    const canon = resolve(inv.supplierName);
    const cur = erfasstMap.get(canon) ?? { sum: 0, count: 0 };
    cur.sum += inv.amountNet;
    cur.count += 1;
    erfasstMap.set(canon, cur);
    addOriginal(originaleErfasst, canon, inv.supplierName, inv.amountNet);
  }
  const erfasstTotal = [...erfasstMap.values()].reduce((a, v) => a + v.sum, 0);

  // ── DEGRADATION: keine Buchungszeilen → nur Total-Vergleich ──
  if (warenBuchungen.length === 0) {
    // Defensive Wache: fehlender/kaputter Buchhaltungswert (null/NaN/Infinity)
    // ⇒ null — Anzeige «—», nie 0 und nie «CHF NaN» rechnen.
    const gebuchtTotal = Number.isFinite(input.buchhaltungTotal) ? input.buchhaltungTotal : null;
    const zeilen: AbgleichZeile[] = [...erfasstMap.entries()]
      .map(([lieferant, v]) => ({
        lieferant, erfasst: v.sum, gebucht: null, diff: null,
        status: 'keine-fibu' as const,
        anzahlRechnungen: v.count, anzahlBuchungen: 0, buchungen: [],
      }))
      .sort((a, b) => (b.erfasst ?? 0) - (a.erfasst ?? 0));
    return {
      mode: 'nur-total', zeilen, erfasstTotal,
      gebuchtTotal,
      diffTotal: gebuchtTotal !== null ? gebuchtTotal - erfasstTotal : null,
      nichtZugeordnet: [], nichtZugeordnetSumme: 0,
      effektiveAliasGruppen: effektiveGruppen,
    };
  }

  // ── Buchungen je Lieferant zuordnen (Buchungstext ↔ Name/Alias) ──
  const gebuchtMap = new Map<string, { sum: number; entries: SageJournalEntry[] }>();
  const nichtZugeordnet: SageJournalEntry[] = [];
  // Buchungstexte auch gegen die Gruppen-Aliasse matchen (Buchhaltungs-Namen
  // wie «Frigemo» existieren u.U. nicht als erfasste Lieferanten) UND gegen
  // die Lieferanten-Namen der ERFASSTEN Rechnungen des Monats (Übernahmen/
  // Alt-Erfassungen tragen oft exakt den Buchhaltungs-Namen wie «Obrist SA»,
  // der im Stammdaten-Lieferantenverzeichnis fehlt — sonst stünde die Buchung
  // «ohne Zuordnung», obwohl dieselbe Rechnung erfasst ist).
  const gruppenAliasNamen = (input.aliasGruppen ?? []).flatMap(g => [...g.aliases, g.name]);
  const erfassteNamen = input.invoices.map(inv => inv.supplierName);
  const matchNamen = [...new Set([...input.supplierNames, ...gruppenAliasNamen, ...erfassteNamen])];
  for (const e of warenBuchungen) {
    // Barausgaben («Barausgabe(n) <Laden>») haben Vorrang vor dem Volltext-
    // Matching: sie werden IMMER als eigener Lieferant pro Laden geführt.
    const hit = barausgabenLieferant(e.text) ?? findSupplierInText(e.text ?? '', matchNamen, input.aliases, resolve);
    if (hit) {
      const canon = resolve(hit);
      const cur = gebuchtMap.get(canon) ?? { sum: 0, entries: [] };
      cur.sum += buchungsBetrag(e);
      cur.entries.push(e);
      gebuchtMap.set(canon, cur);
      addOriginal(originaleGebucht, canon, hit, buchungsBetrag(e));
    } else {
      nichtZugeordnet.push(e);
    }
  }
  const nichtZugeordnetSumme = nichtZugeordnet.reduce((a, e) => a + buchungsBetrag(e), 0);
  const gebuchtTotal = warenBuchungen.reduce((a, e) => a + buchungsBetrag(e), 0);

  // ── Zeilen (Union beider Quellen) ──
  const alleNamen = new Set<string>([...erfasstMap.keys(), ...gebuchtMap.keys()]);
  const zeilen: AbgleichZeile[] = [...alleNamen].map(name => {
    const erf = erfasstMap.get(name) ?? null;
    const geb = gebuchtMap.get(name) ?? null;
    let status: AbgleichStatus;
    let diff: number | null = null;
    if (erf && geb) {
      diff = geb.sum - erf.sum;
      status = Math.abs(diff) > schwelle ? 'abweichung' : 'ok';
    } else if (erf) {
      status = 'nur-erfasst';
    } else {
      status = 'nur-gebucht';
    }
    // Transparenz: Original-Namen nur ausweisen, wenn wirklich zusammengeführt
    // wurde (mehr als ein Original-Name oder Name ≠ Gruppenname).
    const origNamen = new Set<string>([
      ...(originaleErfasst.get(name)?.keys() ?? []),
      ...(originaleGebucht.get(name)?.keys() ?? []),
    ]);
    const zusammengefuehrt = origNamen.size > 1 || (origNamen.size === 1 && [...origNamen][0] !== name);
    const mitglieder = zusammengefuehrt
      ? [...origNamen].map(orig => ({
          name: orig,
          erfasst: originaleErfasst.get(name)?.get(orig) ?? null,
          gebucht: originaleGebucht.get(name)?.get(orig) ?? null,
        })).sort((a, b) => Math.max(b.erfasst ?? 0, b.gebucht ?? 0) - Math.max(a.erfasst ?? 0, a.gebucht ?? 0))
      : undefined;
    return {
      lieferant: name,
      erfasst: erf?.sum ?? null,
      gebucht: geb?.sum ?? null,
      diff,
      status,
      anzahlRechnungen: erf?.count ?? 0,
      anzahlBuchungen: geb?.entries.length ?? 0,
      buchungen: geb?.entries ?? [],
      ...(mitglieder ? { mitglieder } : {}),
    };
  }).sort((a, b) => Math.max(b.erfasst ?? 0, b.gebucht ?? 0) - Math.max(a.erfasst ?? 0, a.gebucht ?? 0));

  return {
    mode: 'lieferanten', zeilen, erfasstTotal, gebuchtTotal,
    diffTotal: gebuchtTotal - erfasstTotal,
    nichtZugeordnet, nichtZugeordnetSumme,
    effektiveAliasGruppen: effektiveGruppen,
  };
}

// ─── Abgleich PRO KONTO (erfasst je Warenkonto vs. Kontoblatt-Buchungen) ─────

export interface KontoAbgleichZeile {
  konto: string;                 // Kontonummer, z.B. '4020'
  bezeichnung: string | null;    // Kontoname (aus Warenkonten-Stammdaten oder Journal)
  erfasst: number;               // Σ netto aus Rechnungen (Splits/Einzelkonto)
  gebucht: number | null;        // Σ Soll−Haben aus dem Journal — null wenn keine Buchungszeile
  diff: number | null;           // erfasst − gebucht, null wenn gebucht null
}

/**
 * Erfasste Rechnungen je Konto gegen das Kontoblatt (gleicher Monat, gleiches
 * Konto). Rechnungen mit kontoSplits zählen pro Split, sonst voll aufs
 * Einzelkonto; ohne Konto bzw. nicht-numerisch («Depot»/«offen») → eigene
 * Zeile ohne Journal-Vergleich. Leere Seiten bleiben null (nie stille 0).
 */
export function buildKontoAbgleich(input: {
  invoices: InvoiceEntry[];
  journal: SageJournalEntry[] | null;
  /** Kontonamen zur Anzeige (value→label), optional. */
  kontoNamen?: Record<string, string>;
  /**
   * Konten, die auch OHNE erfasste Rechnungen (nur-Journal) erscheinen dürfen —
   * typischerweise die konfigurierten Warenkonten. Ohne Angabe wird das ganze
   * Kontoblatt gelistet (kann bei grossen FIBU-Exporten fluten).
   */
  relevanteKonten?: string[];
  /**
   * Lieferanten, die PRO LIEFERANT statt pro Konto verglichen werden (eine
   * Sammelzeile über alle Konten). Grund: die FIBU bucht z.B. Feldschlösschen
   * pauschal auf 4030, während die Erfassung nach Zusammenfassung MwSt.
   * splittet (4030/4040/4050) — ein Pro-Konto-Vergleich wäre systematisch rot.
   * Rechnungen matchen über supplierName, Journal-Buchungen über den Buchungstext.
   */
  lieferantZeilen?: Array<{ name: string; rx: RegExp }>;
}): KontoAbgleichZeile[] {
  const lieferantZeile = (supplierOrText: string): string | null => {
    for (const l of input.lieferantZeilen ?? []) {
      if (l.rx.test(supplierOrText)) return l.name;
    }
    return null;
  };
  const erfasst = new Map<string, number>();
  const add = (konto: string | undefined, net: number) => {
    const k = (konto ?? '').trim() || 'ohne';
    erfasst.set(k, (erfasst.get(k) ?? 0) + net);
  };
  for (const inv of input.invoices) {
    // Pro-Lieferant-Zeile: gesamte Rechnung (alle Splits) in die Sammelzeile —
    // Pseudo-Splits («Depot») bleiben aussen vor (neutral, nie FIBU-relevant).
    const lz = lieferantZeile(inv.supplierName ?? '');
    if (lz) {
      if (inv.kontoSplits && inv.kontoSplits.length > 0) {
        for (const s of inv.kontoSplits) {
          if (s.warenkonto === 'Depot') add('Depot', s.amountNet);
          else add(`~${lz}`, s.amountNet);
        }
      } else if (inv.warenkonto === 'Depot') {
        add('Depot', inv.amountNet); // reine Depot-/Leergut-Rechnung bleibt neutral
      } else {
        add(`~${lz}`, inv.amountNet);
      }
      continue;
    }
    if (inv.kontoSplits && inv.kontoSplits.length > 0) {
      for (const s of inv.kontoSplits) add(s.warenkonto, s.amountNet);
    } else {
      add(inv.warenkonto, inv.amountNet);
    }
  }

  const gebucht = new Map<string, { sum: number; name: string | null }>();
  const gebuchtLieferant = new Map<string, number>();
  for (const e of input.journal ?? []) {
    const k = String(e.accountNumber ?? '').replace(/^0+/, '').trim();
    if (!k) continue;
    const lz = lieferantZeile(e.text ?? '');
    if (lz) {
      gebuchtLieferant.set(lz, (gebuchtLieferant.get(lz) ?? 0) + buchungsBetrag(e));
      continue;
    }
    const cur = gebucht.get(k) ?? { sum: 0, name: e.accountName ?? null };
    cur.sum += buchungsBetrag(e);
    if (!cur.name && e.accountName) cur.name = e.accountName;
    gebucht.set(k, cur);
  }

  const istNumerisch = (k: string) => Number.isFinite(parseInt(k, 10)) && /^\d+$/.test(k);
  const zeilen: KontoAbgleichZeile[] = [];
  for (const [konto, sum] of erfasst) {
    // Pro-Lieferant-Sammelzeile («~Name»): gegen Σ Journal-Buchungen dieses
    // Lieferanten über ALLE Konten vergleichen (FIBU bucht z.B. pauschal 4030).
    if (konto.startsWith('~')) {
      const name = konto.slice(1);
      const jSum = gebuchtLieferant.get(name);
      zeilen.push({
        konto,
        bezeichnung: `${name} (pro Lieferant, alle Konten)`,
        erfasst: Math.round(sum * 100) / 100,
        gebucht: jSum !== undefined ? Math.round(jSum * 100) / 100 : null,
        diff: jSum !== undefined ? Math.round((sum - jSum) * 100) / 100 : null,
      });
      continue;
    }
    const numerisch = istNumerisch(konto);
    const j = numerisch ? gebucht.get(konto.replace(/^0+/, '')) : undefined;
    zeilen.push({
      konto,
      bezeichnung: input.kontoNamen?.[konto] ?? j?.name ?? null,
      erfasst: Math.round(sum * 100) / 100,
      gebucht: j ? Math.round(j.sum * 100) / 100 : null,
      diff: j ? Math.round((sum - j.sum) * 100) / 100 : null,
    });
  }
  // Lieferanten, die NUR im Journal vorkommen (gebucht, aber nichts erfasst):
  for (const [name, sum] of gebuchtLieferant) {
    if (zeilen.some(z => z.konto === `~${name}`)) continue;
    if (Math.abs(sum) < 0.005) continue;
    zeilen.push({
      konto: `~${name}`,
      bezeichnung: `${name} (pro Lieferant, alle Konten)`,
      erfasst: 0,
      gebucht: Math.round(sum * 100) / 100,
      diff: Math.round((0 - sum) * 100) / 100,
    });
  }
  // Konten, die NUR im Journal vorkommen (gebucht, aber nichts erfasst) —
  // auf relevante Konten begrenzt, sonst flutet das ganze Kontoblatt die Sicht:
  const relevant = input.relevanteKonten
    ? new Set(input.relevanteKonten.map(k => k.replace(/^0+/, '').trim()))
    : null;
  for (const [konto, j] of gebucht) {
    if (zeilen.some(z => z.konto.replace(/^0+/, '') === konto)) continue;
    if (Math.abs(j.sum) < 0.005) continue;
    if (relevant && !relevant.has(konto)) continue;
    zeilen.push({
      konto,
      bezeichnung: input.kontoNamen?.[konto] ?? j.name,
      erfasst: 0,
      gebucht: Math.round(j.sum * 100) / 100,
      diff: Math.round((0 - j.sum) * 100) / 100,
    });
  }
  return zeilen.sort((a, b) => a.konto.localeCompare(b.konto, 'de-CH', { numeric: true }));
}

/**
 * Dublettencheck vor dem Speichern (Punkt 11): existiert im Monat bereits
 * eine Rechnung mit gleichem Lieferant + Datum + Betrag (± 5 Rp.) — bzw.
 * gleicher Referenz — wird gewarnt (nie blockiert, der Nutzer entscheidet).
 */
export function findeDublette(
  vorhandene: InvoiceEntry[],
  neu: { supplierName: string; date: string; amountGross: number; reference?: string },
  ignoreId?: string,
): InvoiceEntry | null {
  for (const e of vorhandene) {
    if (ignoreId && e.id === ignoreId) continue;
    if (e.supplierName !== neu.supplierName) continue;
    const refMatch = !!neu.reference && !!e.reference
      && e.reference.trim().toLowerCase() === neu.reference.trim().toLowerCase();
    const feldMatch = e.date === neu.date && Math.abs(e.amountGross - neu.amountGross) < 0.05;
    if (refMatch || feldMatch) return e;
  }
  return null;
}
