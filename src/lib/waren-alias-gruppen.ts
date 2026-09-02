/**
 * waren-alias-gruppen.ts — Lieferanten-Alias-Gruppen (reine Logik).
 * ==================================================================
 * Unterschiedliche Namen in Erfassung und Buchhaltung (z.B. «Prodega» ↔
 * «Transgourmet») werden als EIN kanonischer Lieferant abgeglichen/gruppiert.
 *
 * REINE ANZEIGE-/ABGLEICH-GRUPPIERUNG: gespeicherte Rechnungen und Buchungen
 * bleiben unverändert — es werden nur Namen auf einen Gruppennamen abgebildet
 * (keine Kosten umgebucht, keine Beträge verändert, Totale identisch).
 *
 * Mandantengetrennt: KV `waren_alias_gruppen_v1` (tenantKey-präfixiert,
 * siehe waren-db). Beaulieu erhält Standard-Gruppen, solange noch NIE
 * gespeichert wurde; ein gespeicherter (auch leerer) Stand gewinnt immer.
 */

import { normalizeSupplierKey } from '@/lib/waren-pdf-erkennung';
import type { InvoiceEntry } from '@/lib/waren-db';
import { kanonischerWarenLieferant } from '@/lib/waren-monatsabgleich';

export interface AliasGruppe {
  id: string;
  /** Kanonischer Anzeigename der Gruppe (z.B. «Prodega / Transgourmet»). */
  name: string;
  /** Namens-Aliasse (Erfassungs- UND Buchhaltungs-Schreibweisen). */
  aliases: string[];
}

/** Vorbelegung Beaulieu — gilt nur, solange noch nie gespeichert wurde. */
export const DEFAULT_ALIAS_GRUPPEN_BEAULIEU: AliasGruppe[] = [
  { id: 'grp-prodega-transgourmet', name: 'Prodega / Transgourmet', aliases: ['Prodega', 'Transgourmet'] },
  { id: 'grp-gourmador-frigemo',    name: 'Gourmador (frigemo)',    aliases: ['Gourmador', 'Gourmador (frigemo)', 'Frigemo'] },
  { id: 'grp-ambro-food',            name: 'Ambro Food',             aliases: ['Ambro Food', 'Ambro Food SA'] },
  { id: 'grp-metzgerei-spahni',      name: 'Metzgerei Spahni',       aliases: ['Metzgerei Spahni', 'Spahni'] },
];

/** Tolerante Normalisierung eines gespeicherten Blobs (nie werfen). */
export function normalizeAliasGruppen(raw: unknown): AliasGruppe[] {
  if (!Array.isArray(raw)) return [];
  const out: AliasGruppe[] = [];
  for (const g of raw) {
    if (!g || typeof g !== 'object') continue;
    const o = g as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    const aliases = Array.isArray(o.aliases)
      ? o.aliases.filter((a): a is string => typeof a === 'string' && a.trim() !== '').map(a => a.trim())
      : [];
    if (!name || aliases.length === 0) continue;
    out.push({
      id: typeof o.id === 'string' && o.id ? o.id : `grp-${out.length}-${normalizeSupplierKey(name).replace(/\s+/g, '-')}`,
      name, aliases,
    });
  }
  return out;
}

export type AliasResolver = (name: string) => string;

/**
 * Resolver: Lieferanten-Name → kanonischer Gruppenname (oder unverändert).
 * Matching über normalizeSupplierKey (case-/diakritik-tolerant); auch der
 * Gruppenname selbst zählt als Alias. Leere Namen bleiben unverändert.
 */
export function buildAliasResolver(gruppen: AliasGruppe[]): AliasResolver {
  const map = new Map<string, string>();
  for (const g of gruppen) {
    for (const alias of [...g.aliases, g.name]) {
      const key = kanonischerWarenLieferant(alias);
      if (key) map.set(key, g.name);
    }
  }
  if (map.size === 0) return (name) => name;
  return (name: string) => {
    const key = kanonischerWarenLieferant(name ?? '');
    return (key && map.get(key)) || name;
  };
}

/**
 * Rechnungsliste mit kanonisierten Lieferanten-Namen (immutable) — für
 * Gruppier-Ansichten (Analyse, Ranking, Cockpit). Beträge unverändert;
 * ohne Gruppen wird dieselbe Referenz zurückgegeben.
 */
export function applyAliasGruppen(invoices: InvoiceEntry[], gruppen: AliasGruppe[]): InvoiceEntry[] {
  if (gruppen.length === 0) return invoices;
  const resolve = buildAliasResolver(gruppen);
  let changed = false;
  const out = invoices.map(inv => {
    const canon = resolve(inv.supplierName);
    if (canon === inv.supplierName) return inv;
    changed = true;
    return { ...inv, supplierName: canon };
  });
  return changed ? out : invoices;
}
