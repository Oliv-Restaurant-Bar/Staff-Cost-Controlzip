/**
 * handlers.ts — registry of the existing imports a dropped file can be handed to.
 * ===============================================================================
 * One entry per existing import flow. Adding a type = adding an entry here (plus a classifier rule
 * if it can be recognised automatically). `autoDetect: false` entries are pickable by hand only.
 *
 * Targets are the places that already exist today:
 *   - 'anchor': an inline section on /import (id of the <Section>)
 *   - 'route' : a separate page
 * The client-visible `label` is German on purpose (it is shown in the app).
 */

import { getCategory, type ImportAccessContext, type ImportCategoryId } from '@/lib/import-center';
import type { UnifiedImportTypeId } from './types';
import { tr } from './strings';

export type HandlerTarget =
  | { kind: 'anchor'; id: string }
  | { kind: 'route'; path: string };

export interface ImportHandler {
  id: UnifiedImportTypeId;
  label: string;
  /** Accepted extensions (lower-case, no dot). */
  accepts: string[];
  autoDetect: boolean;
  target: HandlerTarget;
  /** Mirrors the guard of the existing flow; `null` category = admin only (inline admin sections). */
  category: ImportCategoryId | null;
  /**
   * True when the existing flow can already receive a pre-loaded file. Types that are `false` are
   * opened without the file (listed as "navigate only" in the result list).
   */
  acceptsHandover: boolean;
  /**
   * True when the existing flow takes several files at once (Verkaufsdaten up to 4, KPI up to 3, Sales Upload
   * four slots). Everything else takes ONE file per hand-over; the rest of the group waits in the list.
   */
  multiFile?: boolean;
}

export const IMPORT_HANDLERS: ImportHandler[] = [
  { id: 'tagesdaten', label: tr('Tagesdaten (Umsatz, Gäste, Ø-Bon, Marketing)', 'Daily data (revenue, guests, avg. receipt, marketing)'), accepts: ['xlsx'], autoDetect: true,
    target: { kind: 'anchor', id: 'umsatz-ist' }, category: null, acceptsHandover: true },
  { id: 'zbericht-pdf', label: tr('Gastronovi Z-Bericht (PDF)', 'Gastronovi Z-report (PDF)'), accepts: ['pdf'], autoDetect: true,
    target: { kind: 'route', path: '/gastronovi-import' }, category: 'gastronovi', acceptsHandover: true },
  { id: 'gn-kpi-pdf', label: tr('Gäste & Bonanalyse (PDF/CSV)', 'Guests & receipt analysis (PDF/CSV)'), accepts: ['pdf', 'csv'], autoDetect: true,
    target: { kind: 'route', path: '/gastronovi-import' }, category: 'gastronovi', acceptsHandover: true, multiFile: true },
  { id: 'verkaufsdaten', label: tr('Verkaufsdaten Food / Beverage', 'Sales data Food / Beverage'), accepts: ['txt', 'tsv', 'csv'], autoDetect: true,
    target: { kind: 'anchor', id: 'verkaufsdaten-food-beverage' }, category: null, acceptsHandover: true, multiFile: true },
  { id: 'sales-upload', label: tr('Produktumsätze (Verkaufsdaten Upload)', 'Product sales (sales data upload)'), accepts: ['csv', 'txt', 'tsv'], autoDetect: true,
    target: { kind: 'route', path: '/sales-upload' }, category: 'produktumsaetze', acceptsHandover: true, multiFile: true },
  { id: 'foratable-reservationen', label: tr('Foratable Reservationen', 'Foratable reservations'), accepts: ['csv'], autoDetect: true,
    target: { kind: 'route', path: '/foratable-import?tab=reservationen' }, category: 'foratable', acceptsHandover: true },
  { id: 'foratable-gaeste', label: tr('Foratable Gästeexport', 'Foratable guest export'), accepts: ['csv'], autoDetect: true,
    target: { kind: 'route', path: '/foratable-import?tab=gaeste' }, category: 'foratable', acceptsHandover: true },
  { id: 'kontoblatt', label: tr('Erfolgsrechnung / Kontoblätter', 'Income statement / account sheets'), accepts: ['csv', 'pdf', 'xlsx', 'xls'], autoDetect: false,
    target: { kind: 'route', path: '/csv-import' }, category: 'erfolgsrechnung', acceptsHandover: true },
  { id: 'annual-revenue', label: tr('Vorjahr Umsatz', 'Prior-year revenue'), accepts: ['xlsx', 'xls'], autoDetect: false,
    target: { kind: 'anchor', id: 'umsatz-vorjahr' }, category: 'vorjahreswerte', acceptsHandover: true },
  { id: 'annual-cost', label: tr('Vorjahr Kosten (Kontoblatt)', 'Prior-year costs (account sheet)'), accepts: ['xlsx', 'xls', 'pdf'], autoDetect: false,
    target: { kind: 'anchor', id: 'vorjahr-kosten-buchhaltung' }, category: 'vorjahreswerte', acceptsHandover: true },
  { id: 'annual-personnel-cost', label: tr('Vorjahr Personalkosten', 'Prior-year personnel costs'), accepts: ['xlsx', 'xls'], autoDetect: false,
    target: { kind: 'anchor', id: 'personalkosten-vorjahr' }, category: 'vorjahreswerte', acceptsHandover: true },
  { id: 'vj-daily', label: tr('Vorjahr Tagesumsatz', 'Prior-year daily revenue'), accepts: ['xlsx', 'xls'], autoDetect: false,
    target: { kind: 'anchor', id: 'vj-tagesumsatz' }, category: 'vorjahreswerte', acceptsHandover: true },
  // Mirus has two existing importers; the user picks which one gets the file (see classify: both are offered).
  // Import-Center dialog: asks Ersetzen/Aktualisieren first, the dropped file is held until the mode is chosen.
  { id: 'ist-stunden', label: tr('Mirus Ist-Stunden → Import-Center (Ersetzen/Aktualisieren)', 'Mirus actual hours → Import Center (replace/update)'), accepts: ['xlsx', 'xls'], autoDetect: true,
    target: { kind: 'anchor', id: 'ist-stunden' }, category: 'mitarbeitende', acceptsHandover: true },
  // Schedule screen, Ist view: reconcile plan (patterns 1–5), backup, undo. Month is taken from the file.
  { id: 'mirus-schedule', label: tr('Mirus Ist-Stunden → Dienstplan (Ist-Ansicht)', 'Mirus actual hours → Schedule (actual view)'), accepts: ['xlsx', 'xls'], autoDetect: true,
    target: { kind: 'route', path: '/personal' }, category: 'mitarbeitende', acceptsHandover: true },
  { id: 'ist-stunden-csv', label: tr('Ist-Stunden (CSV)', 'Actual hours (CSV)'), accepts: ['csv'], autoDetect: false,
    target: { kind: 'anchor', id: 'ist-stunden' }, category: 'mitarbeitende', acceptsHandover: false },
  { id: 'rezensionen', label: tr('Rezensionen (Lunchgate/Google CSV)', 'Reviews (Lunchgate/Google CSV)'), accepts: ['csv'], autoDetect: true,
    target: { kind: 'route', path: '/rezensionen' }, category: 'produktumsaetze', acceptsHandover: true },
  { id: 'umsatzkategorien', label: tr('Umsatzanalyse Kategorien (Excel)', 'Revenue analysis categories (Excel)'), accepts: ['xlsx'], autoDetect: true,
    target: { kind: 'route', path: '/produkt-analyse?tab=umsatzkategorien' }, category: 'produktumsaetze', acceptsHandover: true },
];

export function getHandler(id: UnifiedImportTypeId): ImportHandler {
  const h = IMPORT_HANDLERS.find(x => x.id === id);
  if (!h) throw new Error(`Unknown unified import type: ${id}`);
  return h;
}

/** Handlers whose input can be the given extension (used for manual pick lists). */
export function handlersForExtension(ext: string): ImportHandler[] {
  return IMPORT_HANDLERS.filter(h => h.accepts.includes(ext));
}

/** Extensions the drop zone accepts at all. */
export const SUPPORTED_EXTENSIONS: string[] = Array.from(new Set(IMPORT_HANDLERS.flatMap(h => h.accepts)));

/**
 * May this role use the handler? Same guard as the existing flow: category handlers reuse the
 * Import Center rule, inline admin sections are admin only.
 */
export function canUseHandler(id: UnifiedImportTypeId, ctx: ImportAccessContext): boolean {
  const h = getHandler(id);
  if (h.category === null) return ctx.isAdmin;
  return getCategory(h.category)?.canAccess(ctx) ?? false;
}
