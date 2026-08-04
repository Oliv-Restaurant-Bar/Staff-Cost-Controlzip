/**
 * waren-db – Warenrechnungen Datenschicht
 * =========================================
 * Speichert Lieferanten und Rechnungseinträge im Supabase app_settings KV-Store.
 * Mandantentrennung via tenantKey-Präfix (beaulieu: oder leer für oliv).
 *
 * Schlüssel:
 *   suppliers_v1              → Array<Supplier>
 *   supplier_invoices_YYYY-MM → Array<InvoiceEntry>
 *
 * Debug-Logs: [WAREN]
 */

import { kvGet, kvSet } from './supabase-kv';
import { tenantKey } from './tenant-utils';
import type { TenantId } from '@/contexts/TenantContext';
import {
  type WarenKategorie,
  kategorieFromKonto,
  kontoKategorie,
} from './warenkosten-quote';

// WarenKategorie + kategorieFromKonto leben zentral in `warenkosten-quote`
// (reine, IO-freie Lib = Single Source of Truth). Re-Export aus Kompatibilität,
// damit bestehende Importe aus `@/lib/waren-db` weiter funktionieren.
export { kategorieFromKonto, kontoKategorie };
export type { WarenKategorie };

// ─── Typen ────────────────────────────────────────────────────────────────────

export interface Supplier {
  id: string;
  name: string;
  active: boolean;
  createdAt: string;
  /** Standard-Warenkonto: füllt sich bei Lieferanten-Wahl im Formular vor. */
  defaultWarenkonto?: string;
  /** Standard-Kategorie (Food/Beverage/Sonstiges): füllt sich vor. */
  defaultKategorie?: WarenKategorie;
  /** Üblicher MwSt-Satz in % (aus Lieferanten-Profil): füllt sich vor. */
  defaultVatRate?: number;
}

/**
 * Zuordnung eines Rechnungsbetrags zu einem Warenkonto.
 * Wird für die optionale Kontoaufteilung (Split auf 2 Konten) verwendet.
 */
export interface KontoSplit {
  warenkonto: string;   // Kontonummer, z.B. "4000"
  amountGross: number;
  amountNet: number;
}

export interface InvoiceEntry {
  id: string;
  date: string;          // YYYY-MM-DD
  supplierName: string;
  amountGross: number;   // Betrag inkl. MWST (Gesamtbetrag)
  amountNet: number;     // Betrag exkl. MWST (Gesamtbetrag)
  vatIncluded: boolean;  // true = Eingabe war Brutto, false = Netto
  vatRate: number;       // z.B. 8.1 oder 2.6
  reference?: string;    // Rechnungs- oder Lieferscheinnummer
  note?: string;
  /** Optionales Warenkonto (einfache Zuweisung, kein Split) */
  warenkonto?: string;
  /** Optionale Kontoaufteilung auf 2 Konten (überschreibt warenkonto wenn vorhanden) */
  kontoSplits?: KontoSplit[];
  /** Kategorie für Food/Beverage-Auswertung (Standard: Sonstiges) */
  kategorie?: WarenKategorie;
  /** Optionaler Beleg/Screenshot im privaten Storage-Bucket `waren-belege` (Pfad `<tenantId>/<id>.<ext>`). */
  receiptPath?: string;
  /**
   * Herkunft der Buchung. Rangordnung (Dual-Lieferanten):
   * Monatsrechnung (final) > Lieferschein/Auftragsbestätigung (provisorisch).
   * 'monatsrechnung' + final=true: massgebliche finale Buchung aus der
   * Monatsrechnung. Ohne final (Alt-Daten): provisorischer Lückenfüller.
   * 'auftragsbestaetigung': provisorisch (AB gilt als Lieferschein, Terravigna).
   * Fehlt das Feld = regulär/Lieferschein erfasst (provisorisch im Dual-Modell).
   */
  quelle?: 'monatsrechnung' | 'auftragsbestaetigung';
  /** true = durch die massgebliche Monatsrechnung finalisiert; spätere
   *  Lieferschein-/AB-Uploads dürfen diese Werte NICHT mehr verschlechtern. */
  final?: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── Beleg-/Screenshot-Upload (privater Bucket `waren-belege`) ───────────────

const RECEIPT_BUCKET = 'waren-belege';
const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;
const RECEIPT_MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf',
};

/** Wirft, wenn der Pfad nicht zum aktuellen Mandanten gehört (Tenant-Grenze). */
function assertTenantReceiptPath(tenantId: TenantId, path: string): void {
  if (!path.startsWith(`${tenantId}/`) || path.includes('..')) {
    throw new Error('Beleg-Pfad gehört nicht zu diesem Mandanten.');
  }
}

/** Beleg hochladen (JPEG/PNG/WebP/PDF, max. 10 MB); gibt den Storage-Pfad zurück. */
export async function uploadInvoiceReceipt(tenantId: TenantId, invoiceId: string, file: File): Promise<string> {
  const ext = RECEIPT_MIME_EXT[file.type];
  if (!ext) throw new Error('Nur JPEG, PNG, WebP oder PDF sind als Beleg erlaubt.');
  if (file.size > RECEIPT_MAX_BYTES) throw new Error('Beleg zu gross (max. 10 MB).');
  const path = `${tenantId}/${invoiceId}.${ext}`;
  const { supabase } = await import('@/integrations/supabase/client');
  const { error } = await supabase.storage.from(RECEIPT_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: true });
  if (error) throw new Error(`Beleg-Upload fehlgeschlagen: ${error.message}`);
  return path;
}

/** Kurzlebige Anzeige-URL (1 h); nur für Pfade des aktuellen Mandanten. */
export async function getInvoiceReceiptUrl(tenantId: TenantId, path: string): Promise<string> {
  assertTenantReceiptPath(tenantId, path);
  const { supabase } = await import('@/integrations/supabase/client');
  const { data, error } = await supabase.storage.from(RECEIPT_BUCKET).createSignedUrl(path, 3600);
  if (error || !data?.signedUrl) throw new Error(`Beleg-URL fehlgeschlagen: ${error?.message ?? 'unbekannt'}`);
  return data.signedUrl;
}

/** Beleg löschen (best effort); nur für Pfade des aktuellen Mandanten. */
export async function deleteInvoiceReceipt(tenantId: TenantId, path: string): Promise<void> {
  assertTenantReceiptPath(tenantId, path);
  const { supabase } = await import('@/integrations/supabase/client');
  await supabase.storage.from(RECEIPT_BUCKET).remove([path]);
}

// ─── Warenkonto Schnellauswahl ────────────────────────────────────────────────

export const WARENKONTO_LIST: { value: string; label: string }[] = [
  { value: '4000', label: '4000 – Warenaufwand Lebensmittel' },
  { value: '4020', label: '4020 – Warenaufwand Getränke' },
  { value: '4030', label: '4030 – Warenaufwand Tiefkühl' },
  { value: '4040', label: '4040 – Warenaufwand Tabakwaren' },
  { value: '4050', label: '4050 – Warenaufwand Reinigung' },
  { value: '4060', label: '4060 – Warenaufwand Diverses' },
  { value: '4071', label: '4071 – Eigenverbrauch' },
  { value: '6040', label: '6040 – Betriebsaufwand' },
];

// kategorieFromKonto: siehe `warenkosten-quote` (re-exportiert oben).

// ─── Warenkonten (frei definierbare Liste, pro Mandant) ──────────────────────
//
// KV-Schlüssel `warenkonten_v1`; leer/fehlend → WARENKONTO_LIST als Vorgabe.
// Bestehende Rechnungen referenzieren Konten nur über `value` (Kontonummer),
// gelöschte Konten machen alte Buchungen deshalb nicht kaputt.

export interface Warenkonto {
  value: string; // Kontonummer, z.B. "4000"
  label: string; // Anzeigename, z.B. "4000 – Warenaufwand Lebensmittel"
  /** Standard-Kategorie des Kontos (Food/Beverage/Sonstiges); fehlt → kategorieFromKonto. */
  kategorie?: WarenKategorie;
}

// kontoKategorie: siehe `warenkosten-quote` (pure Lib, re-exportiert oben).

// ─── Warenkosten-Grenze (Kontoklassen-Grenze, pro Mandant) ───────────────────
//
// Konten 4000–Grenze = Warenkosten (WKQ), darüber = Betriebskosten.
// KV `waren_grenze_v1`; fehlend/ungültig → DEFAULT_WARENKOSTEN_GRENZE (4090).

export async function loadWarenkostenGrenze(tenantId: TenantId): Promise<number> {
  const { DEFAULT_WARENKOSTEN_GRENZE } = await import('./waren-klassen');
  try {
    const raw = await kvGet(tenantKey(tenantId, 'waren_grenze_v1'));
    const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
    if (Number.isFinite(n) && n >= 4000 && n <= 9999) return n;
  } catch { /* Lesefehler → Standard */ }
  return DEFAULT_WARENKOSTEN_GRENZE;
}

export async function saveWarenkostenGrenze(tenantId: TenantId, grenze: number): Promise<void> {
  if (!Number.isFinite(grenze) || grenze < 4000 || grenze > 9999) {
    throw new Error('Warenkosten-Grenze muss zwischen 4000 und 9999 liegen.');
  }
  await kvSet(tenantKey(tenantId, 'waren_grenze_v1'), grenze);
  console.log(`[WAREN] warenkosten-grenze saved: ${grenze} for tenant "${tenantId}"`);
}

function warenkontenKey(tenantId: TenantId): string {
  return tenantKey(tenantId, 'warenkonten_v1');
}

export async function loadWarenkonten(tenantId: TenantId): Promise<Warenkonto[]> {
  const raw = await kvGet(warenkontenKey(tenantId));
  if (Array.isArray(raw) && raw.length > 0) return raw as Warenkonto[];
  return WARENKONTO_LIST;
}

export async function saveWarenkonten(tenantId: TenantId, konten: Warenkonto[]): Promise<void> {
  await kvSet(warenkontenKey(tenantId), konten);
  console.log(`[WAREN] warenkonten saved: ${konten.length} entries for tenant "${tenantId}"`);
}

// ─── Lieferanten-Aliasse (PDF-Erkennung) ─────────────────────────────────────
//
// Erkannte Schreibweisen → Lieferanten-Name, pro Mandant. KV-Schlüssel
// `waren_lieferanten_aliases_v1`; Keys sind normalisiert
// (normalizeSupplierKey aus waren-pdf-erkennung).

function supplierAliasesKey(tenantId: TenantId): string {
  return tenantKey(tenantId, 'waren_lieferanten_aliases_v1');
}

export async function loadSupplierAliases(tenantId: TenantId): Promise<Record<string, string>> {
  const raw = await kvGet(supplierAliasesKey(tenantId));
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, string> : {};
}

/** Alias dauerhaft speichern (Merge auf frischem Remote-Stand, nie Wipe). */
export async function saveSupplierAlias(
  tenantId: TenantId, aliasKey: string, supplierName: string,
): Promise<void> {
  if (!aliasKey.trim()) return;
  const cur = await loadSupplierAliases(tenantId);
  cur[aliasKey] = supplierName;
  await kvSet(supplierAliasesKey(tenantId), cur);
  console.log(`[WAREN] Alias gespeichert: "${aliasKey}" → "${supplierName}" (${tenantId})`);
}

// ─── Lieferanten-Alias-Gruppen (FIBU-Abgleich/Analyse-Gruppierung) ───────────
//
// KV `waren_alias_gruppen_v1` — { groups: AliasGruppe[] }. WICHTIG:
// «noch nie gespeichert» (Key fehlt) ≠ «leer gespeichert»: nur im ersten Fall
// erhält Beaulieu die Standard-Gruppen (Prodega/Transgourmet, Gourmador/
// Frigemo); ein gespeicherter Stand (auch []) gewinnt immer.

function aliasGruppenKey(tenantId: TenantId): string {
  return tenantKey(tenantId, 'waren_alias_gruppen_v1');
}

export async function loadAliasGruppen(
  tenantId: TenantId,
): Promise<import('./waren-alias-gruppen').AliasGruppe[]> {
  const { normalizeAliasGruppen, DEFAULT_ALIAS_GRUPPEN_BEAULIEU } = await import('./waren-alias-gruppen');
  try {
    const raw = await kvGet(aliasGruppenKey(tenantId));
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'groups' in (raw as object)) {
      return normalizeAliasGruppen((raw as { groups: unknown }).groups);
    }
  } catch { /* Lesefehler → wie fehlend behandeln (nur Anzeige-Gruppierung) */ }
  return tenantId === 'beaulieu' ? DEFAULT_ALIAS_GRUPPEN_BEAULIEU : [];
}

export async function saveAliasGruppen(
  tenantId: TenantId,
  gruppen: import('./waren-alias-gruppen').AliasGruppe[],
): Promise<void> {
  await kvSet(aliasGruppenKey(tenantId), { groups: gruppen });
  console.log(`[WAREN] alias-gruppen saved: ${gruppen.length} groups for tenant "${tenantId}"`);
}

// ─── Manuelle/automatische FIBU-Matches (Rechnungen ↔ Buchungen, pro Monat) ──
//
// KV `waren_fibu_matches_<YYYY-MM>_v1` — { gruppen: FibuMatchGruppe[],
// gesperrt: {invoiceIds, buchungKeys} }. Rein zuordnend/visuell (keine
// Betragsänderung), mandantengetrennt. Alt-Blobs ohne `gesperrt` laden sauber.

function fibuMatchesKey(tenantId: TenantId, monthKey: string): string {
  return tenantKey(tenantId, `waren_fibu_matches_${monthKey}_v1`);
}

export async function loadFibuMatchState(
  tenantId: TenantId,
  monthKey: string,
): Promise<import('./waren-fibu-matches').FibuMatchState> {
  const { normalizeFibuMatchState, LEERER_MATCH_STATE } = await import('./waren-fibu-matches');
  try {
    return normalizeFibuMatchState(await kvGet(fibuMatchesKey(tenantId, monthKey)));
  } catch {
    return LEERER_MATCH_STATE; // Lesefehler → keine Markierungen (nie werfen, rein visuell)
  }
}

export async function saveFibuMatchState(
  tenantId: TenantId,
  monthKey: string,
  state: import('./waren-fibu-matches').FibuMatchState,
): Promise<void> {
  await kvSet(fibuMatchesKey(tenantId, monthKey), state);
  console.log(`[WAREN] fibu-matches saved: ${state.gruppen.length} groups (${monthKey}, tenant "${tenantId}")`);
}

// ─── Preisüberwachung: Historie, Schwelle, Hinweise (mandantengetrennt) ──────
//
// - `waren_preishistorie_v1`: letzter Einzelpreis pro (Lieferant+Artikel).
// - `waren_preis_schwelle_v1`: { pct, minChf } (Default 10 % / 0.20 CHF).
// - `waren_preishinweise_<YYYY-MM>_v1`: Record<invoiceId, PreisAenderung[]>
//   (Hinweis-Icons an den Rechnungen; rein informativ, nie werfen beim Lesen).

export async function loadPreisHistorie(tenantId: TenantId): Promise<import('./waren-positionen').PreisHistorie> {
  const { normalizePreisHistorie } = await import('./waren-positionen');
  try { return normalizePreisHistorie(await kvGet(tenantKey(tenantId, 'waren_preishistorie_v1'))); }
  catch { return {}; }
}

export async function savePreisHistorie(tenantId: TenantId, historie: import('./waren-positionen').PreisHistorie): Promise<void> {
  await kvSet(tenantKey(tenantId, 'waren_preishistorie_v1'), historie);
}

export async function loadPreisSchwelle(tenantId: TenantId): Promise<import('./waren-positionen').PreisSchwelle> {
  const { normalizePreisSchwelle, DEFAULT_PREIS_SCHWELLE } = await import('./waren-positionen');
  try {
    const raw = await kvGet(tenantKey(tenantId, 'waren_preis_schwelle_v1'));
    return raw === null || raw === undefined ? DEFAULT_PREIS_SCHWELLE : normalizePreisSchwelle(raw);
  } catch { return DEFAULT_PREIS_SCHWELLE; }
}

export async function savePreisSchwelle(tenantId: TenantId, schwelle: import('./waren-positionen').PreisSchwelle): Promise<void> {
  await kvSet(tenantKey(tenantId, 'waren_preis_schwelle_v1'), schwelle);
}

export async function loadPreisHinweise(
  tenantId: TenantId, monthKey: string,
): Promise<Record<string, import('./waren-positionen').PreisAenderung[]>> {
  try {
    const raw = await kvGet(tenantKey(tenantId, `waren_preishinweise_${monthKey}_v1`));
    return raw && typeof raw === 'object' ? raw as Record<string, import('./waren-positionen').PreisAenderung[]> : {};
  } catch { return {}; }
}

export async function savePreisHinweise(
  tenantId: TenantId, monthKey: string,
  hinweise: Record<string, import('./waren-positionen').PreisAenderung[]>,
): Promise<void> {
  await kvSet(tenantKey(tenantId, `waren_preishinweise_${monthKey}_v1`), hinweise);
}

// ─── Warengruppe → Konto (konfigurierbare Zuordnungstabelle, pro Mandant) ────

export async function loadWarengruppenMapping(tenantId: TenantId): Promise<import('./waren-positionen').WarengruppenMapping> {
  const { normalizeWarengruppenMapping, DEFAULT_WARENGRUPPEN_MAPPING } = await import('./waren-positionen');
  try {
    const raw = await kvGet(tenantKey(tenantId, 'waren_warengruppen_konten_v1'));
    return raw === null || raw === undefined ? DEFAULT_WARENGRUPPEN_MAPPING : normalizeWarengruppenMapping(raw);
  } catch {
    const { DEFAULT_WARENGRUPPEN_MAPPING: def } = await import('./waren-positionen');
    return def;
  }
}

export async function saveWarengruppenMapping(tenantId: TenantId, mapping: import('./waren-positionen').WarengruppenMapping): Promise<void> {
  await kvSet(tenantKey(tenantId, 'waren_warengruppen_konten_v1'), mapping);
}

// ─── Artikel → Konto (in der Vorschau gelernte Zuordnungen, pro Mandant) ─────

export async function loadArtikelKonten(tenantId: TenantId): Promise<import('./waren-positionen').ArtikelKontenMapping> {
  const { normalizeArtikelKonten } = await import('./waren-positionen');
  try { return normalizeArtikelKonten(await kvGet(tenantKey(tenantId, 'waren_artikel_konten_v1'))); }
  catch { return {}; }
}

/** Merge-Save: bestehende Zuordnungen bleiben, neue/gesetzte überschreiben. */
export async function saveArtikelKonten(
  tenantId: TenantId, neue: import('./waren-positionen').ArtikelKontenMapping,
): Promise<void> {
  if (Object.keys(neue).length === 0) return;
  const bestehend = await loadArtikelKonten(tenantId);
  await kvSet(tenantKey(tenantId, 'waren_artikel_konten_v1'), { ...bestehend, ...neue });
}

// ─── Rechnungspositionen (pro Monat, Record<invoiceId, Positionen>) ──────────

export async function loadRechnungsPositionen(
  tenantId: TenantId, monthKey: string,
): Promise<import('./waren-positionen').PositionenProRechnung> {
  const { normalizePositionenProRechnung } = await import('./waren-positionen');
  try { return normalizePositionenProRechnung(await kvGet(tenantKey(tenantId, `waren_positionen_${monthKey}_v1`))); }
  catch { return {}; }
}

export async function saveRechnungsPositionen(
  tenantId: TenantId, monthKey: string,
  positionen: import('./waren-positionen').PositionenProRechnung,
): Promise<void> {
  await kvSet(tenantKey(tenantId, `waren_positionen_${monthKey}_v1`), positionen);
}

// ─── Auto-Match-Toleranz (CHF, pro Mandant, Default 10.00) ───────────────────

export async function loadFibuMatchToleranz(tenantId: TenantId): Promise<number> {
  const { DEFAULT_FIBU_MATCH_TOLERANZ } = await import('./waren-fibu-matches');
  try {
    const raw = await kvGet(tenantKey(tenantId, 'waren_fibu_toleranz_v1'));
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_FIBU_MATCH_TOLERANZ;
  } catch {
    return DEFAULT_FIBU_MATCH_TOLERANZ;
  }
}

export async function saveFibuMatchToleranz(tenantId: TenantId, toleranz: number): Promise<void> {
  await kvSet(tenantKey(tenantId, 'waren_fibu_toleranz_v1'), toleranz);
}

// ─── Zuletzt genutzte Lieferanten (nur Sortier-Komfort, localStorage) ────────

const RECENT_SUPPLIERS_MAX = 8;

function recentSuppliersKey(tenantId: TenantId): string {
  return `waren_recent_suppliers_${tenantId}`;
}

export function loadRecentSupplierNames(tenantId: TenantId): string[] {
  try {
    const raw = localStorage.getItem(recentSuppliersKey(tenantId));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

export function rememberRecentSupplier(tenantId: TenantId, name: string): string[] {
  const list = [name, ...loadRecentSupplierNames(tenantId).filter(n => n !== name)]
    .slice(0, RECENT_SUPPLIERS_MAX);
  try { localStorage.setItem(recentSuppliersKey(tenantId), JSON.stringify(list)); } catch { /* egal */ }
  return list;
}

// ─── Standard-Lieferanten ─────────────────────────────────────────────────────

export const DEFAULT_SUPPLIERS: string[] = [
  'Prodega',
  'Transgourmet',
  'Blaser Café',
  'Metzgerei Spahni',
  'Siebe Dupf',
  'Feldschlösschen',
  'Chocolats Camille',
  'Caporaso',
  'Ambro Food',
  'La Marra',
  'Asia Company',
  'Amarx Espro',
  'Terravigna',
  'Fideco',
  'Korngold',
  'Paul Ulrich',
  'Hiestand',
  'Frigemo',
  'Compagnie Desserts',
];

// ─── Schlüssel-Helfer ─────────────────────────────────────────────────────────

function suppliersKey(tenantId: TenantId): string {
  return tenantKey(tenantId, 'suppliers_v1');
}

function invoicesKey(tenantId: TenantId, monthKey: string): string {
  return tenantKey(tenantId, `supplier_invoices_${monthKey}`);
}

function monthKey(date: string): string {
  return date.slice(0, 7); // YYYY-MM
}

// ─── Lieferanten ─────────────────────────────────────────────────────────────

export async function loadSuppliers(tenantId: TenantId): Promise<Supplier[]> {
  const key = suppliersKey(tenantId);
  const raw = await kvGet(key);
  if (Array.isArray(raw) && raw.length > 0) {
    return raw as Supplier[];
  }
  // Initialisierung mit Standard-Lieferanten
  const defaults = DEFAULT_SUPPLIERS.map((name, i) => ({
    id: `sup-${i + 1}`,
    name,
    active: true,
    createdAt: new Date().toISOString(),
  }));
  await kvSet(key, defaults);
  console.log(`[WAREN] supplier list initialized: ${defaults.length} default suppliers for tenant "${tenantId}"`);
  return defaults;
}

export async function saveSuppliers(tenantId: TenantId, suppliers: Supplier[]): Promise<void> {
  const key = suppliersKey(tenantId);
  await kvSet(key, suppliers);
  console.log(`[WAREN] suppliers saved: ${suppliers.length} entries for tenant "${tenantId}"`);
}

// ─── Rechnungseinträge ────────────────────────────────────────────────────────

export async function loadMonthInvoices(
  tenantId: TenantId,
  month: string, // YYYY-MM
): Promise<InvoiceEntry[]> {
  const key = invoicesKey(tenantId, month);
  const raw = await kvGet(key);
  if (Array.isArray(raw)) return raw as InvoiceEntry[];
  return [];
}

export async function saveInvoiceEntry(
  tenantId: TenantId,
  entry: InvoiceEntry,
): Promise<void> {
  const month = monthKey(entry.date);
  const key = invoicesKey(tenantId, month);
  const existing = await loadMonthInvoices(tenantId, month);
  const idx = existing.findIndex(e => e.id === entry.id);
  if (idx >= 0) {
    existing[idx] = { ...entry, updatedAt: new Date().toISOString() };
    console.log(`[WAREN] entry updated: id=${entry.id} date=${entry.date} supplier=${entry.supplierName} net=${entry.amountNet.toFixed(2)} gross=${entry.amountGross.toFixed(2)}`);
  } else {
    existing.push(entry);
    console.log(`[WAREN] entry saved: id=${entry.id} date=${entry.date} supplier=${entry.supplierName} net=${entry.amountNet.toFixed(2)} gross=${entry.amountGross.toFixed(2)}`);
  }
  await kvSet(key, existing);
}

/** Ganzen Monatsbestand in einem Schreibvorgang ersetzen (Import-Pipelines). */
export async function saveMonthInvoices(
  tenantId: TenantId,
  month: string, // YYYY-MM
  entries: InvoiceEntry[],
): Promise<void> {
  await kvSet(invoicesKey(tenantId, month), entries);
  console.log(`[WAREN] month saved: ${month} (${entries.length} entries) tenant="${tenantId}"`);
}

export async function deleteInvoiceEntry(
  tenantId: TenantId,
  entryId: string,
  date: string,
): Promise<void> {
  const month = monthKey(date);
  const key = invoicesKey(tenantId, month);
  const existing = await loadMonthInvoices(tenantId, month);
  const filtered = existing.filter(e => e.id !== entryId);
  await kvSet(key, filtered);
  console.log(`[WAREN] entry deleted: id=${entryId} date=${date} tenant="${tenantId}"`);
}

// ─── Tagesumsatz aus dailyBudgets ─────────────────────────────────────────────

export interface DailyRevenue {
  date: string;
  actualRevenue: number;
}

export function loadDailyRevenueFromLocalStorage(
  tenantId: TenantId,
  month: string, // YYYY-MM
): Record<string, number> {
  const lsKey = tenantId === 'oliv' ? 'dailyBudgets' : 'beaulieu:dailyBudgets';
  try {
    const raw = localStorage.getItem(lsKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, { actualRevenue?: number }>;
    const result: Record<string, number> = {};
    for (const [date, val] of Object.entries(parsed)) {
      if (date.startsWith(month)) {
        result[date] = val.actualRevenue ?? 0;
      }
    }
    return result;
  } catch {
    return {};
  }
}

// ─── Monatliches Umsatz-Budget (Warenrechnungen-Analyse) ──────────────────────

/**
 * Schlüssel für das monatliche Umsatz-Budget im KV-Store.
 * Format: { "YYYY-MM": CHF_Betrag, ... }
 * Beispiel Beaulieu 2026: beaulieu:waren_monthly_rev_2026 = { "2026-01": 120000, ... }
 */
function monthlyRevKey(tenantId: TenantId, year: number): string {
  return tenantKey(tenantId, `waren_monthly_rev_${year}`);
}

/**
 * Lädt das monatliche Umsatz-Budget für ein Jahr aus dem KV-Store.
 * Gibt ein leeres Objekt zurück wenn kein Budget gesetzt ist.
 */
export async function loadWarenMonthlyRevenue(
  tenantId: TenantId,
  year: number,
): Promise<Record<string, number>> {
  const key = monthlyRevKey(tenantId, year);
  const raw = await kvGet(key);
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, number>;
  }
  return {};
}

/**
 * Speichert das monatliche Umsatz-Budget für ein Jahr im KV-Store.
 * @param data Record mit "YYYY-MM" → CHF-Betrag (z.B. { "2026-01": 120000 })
 */
export async function saveWarenMonthlyRevenue(
  tenantId: TenantId,
  year: number,
  data: Record<string, number>,
): Promise<void> {
  const key = monthlyRevKey(tenantId, year);
  await kvSet(key, data);
  console.log(`[WAREN] monthly revenue budget saved: year=${year} tenant="${tenantId}" months=${Object.keys(data).length}`);
}

/**
 * Tagesgewichte für die Umsatzverteilung.
 * Index = getDay() Rückgabewert: 0=So, 1=Mo, 2=Di, 3=Mi, 4=Do, 5=Fr, 6=Sa
 * Restaurant Beaulieu: Mo–Fr = 15, Sa = 10, So = 0 (geschlossen)
 */
export const WAREN_DAY_WEIGHTS = [0, 15, 15, 15, 15, 15, 10];

/**
 * Berechnet den tagesgenauen Budget-Umsatz basierend auf den Tagesgewichten.
 * @param monthBudget Monatlicher Gesamtbudget-Umsatz in CHF
 * @param dayStr Datum des Tages (YYYY-MM-DD)
 * @param allDaysInMonth Alle Tage des Monats (YYYY-MM-DD[])
 * @returns Anteil des Tages am Monatsbudget
 */
export function computeDailyBudgetRevenue(
  monthBudget: number,
  dayStr: string,
  allDaysInMonth: string[],
): number {
  const totalWeight = allDaysInMonth.reduce((s, d) => {
    const dow = new Date(d + 'T12:00:00').getDay();
    return s + WAREN_DAY_WEIGHTS[dow];
  }, 0);
  if (totalWeight === 0) return 0;
  const dow = new Date(dayStr + 'T12:00:00').getDay();
  const w = WAREN_DAY_WEIGHTS[dow];
  return w === 0 ? 0 : (w / totalWeight) * monthBudget;
}

/**
 * Vordefinierte monatliche Umsatz-Budgets.
 * Quelle: Budget_Beaulieu_2026.xlsx – BETRIEBSERTRAG NETTO
 */
const PRESET_MONTHLY_BUDGETS: Record<string, Record<string, number>> = {
  'beaulieu:waren_monthly_rev_2026': {
    '2026-01': 120000,
    '2026-02': 130000,
    '2026-03': 150000,
    '2026-04': 200000,
    '2026-05': 170000,
    '2026-06': 160000,
    '2026-07': 120000,
    '2026-08': 140000,
    '2026-09': 130000,
    '2026-10': 170000,
    '2026-11': 200000,
    '2026-12': 200000,
  },
};

/**
 * Seed-Funktion: Trägt vordefinierte Budgets automatisch ein wenn noch kein Eintrag vorhanden.
 * Wird beim ersten Laden des Analyse-Tabs aufgerufen (läuft im authentifizierten Browser-Client).
 */
export async function seedMonthlyRevenueIfMissing(
  tenantId: TenantId,
  year: number,
): Promise<void> {
  const key = monthlyRevKey(tenantId, year);
  const existing = await kvGet(key);
  if (existing && typeof existing === 'object' && Object.keys(existing).length > 0) {
    console.log(`[WAREN] monthly revenue budget already exists for ${key}, skipping seed`);
    return;
  }
  const preset = PRESET_MONTHLY_BUDGETS[key];
  if (!preset) return;
  await kvSet(key, preset);
  console.log(`[WAREN] monthly revenue budget seeded for ${key}: ${Object.keys(preset).length} months`);
}

// ─── Berechnungshelfer ────────────────────────────────────────────────────────

export function calcAmounts(
  amount: number,
  vatIncluded: boolean,
  vatRate: number,
): { amountGross: number; amountNet: number } {
  if (vatIncluded) {
    const amountGross = amount;
    const amountNet = amount / (1 + vatRate / 100);
    return { amountGross, amountNet };
  } else {
    const amountNet = amount;
    const amountGross = amount * (1 + vatRate / 100);
    return { amountGross, amountNet };
  }
}

// ─── Monatsstatistik ──────────────────────────────────────────────────────────

export interface SupplierMonthTotal {
  supplierName: string;
  totalNet: number;
  totalGross: number;
  entryCount: number;
  byDate: Record<string, number>; // date → net amount
}

export interface MonthStats {
  totalNet: number;
  totalGross: number;
  supplierTotals: SupplierMonthTotal[];
  revenueByDate: Record<string, number>;
  entryCount: number;
}

export function computeMonthStats(
  entries: InvoiceEntry[],
  revenueByDate: Record<string, number>,
): MonthStats {
  const supplierMap = new Map<string, SupplierMonthTotal>();

  let totalNet = 0;
  let totalGross = 0;

  for (const e of entries) {
    totalNet += e.amountNet;
    totalGross += e.amountGross;

    if (!supplierMap.has(e.supplierName)) {
      supplierMap.set(e.supplierName, {
        supplierName: e.supplierName,
        totalNet: 0,
        totalGross: 0,
        entryCount: 0,
        byDate: {},
      });
    }
    const st = supplierMap.get(e.supplierName)!;
    st.totalNet += e.amountNet;
    st.totalGross += e.amountGross;
    st.entryCount++;
    st.byDate[e.date] = (st.byDate[e.date] ?? 0) + e.amountNet;
  }

  const supplierTotals = Array.from(supplierMap.values()).sort(
    (a, b) => b.totalNet - a.totalNet,
  );

  const totalRevenue = Object.values(revenueByDate).reduce((s, v) => s + v, 0);
  const totalRevenuePct = totalRevenue > 0 ? (totalNet / totalRevenue) * 100 : 0;

  console.log(`[WAREN] month total chf: ${totalNet.toFixed(2)} net / ${totalGross.toFixed(2)} gross`);
  console.log(`[WAREN] month total pct: ${totalRevenuePct.toFixed(1)}%`);
  console.log(`[WAREN] supplier totals: ${supplierTotals.map(s => `${s.supplierName}=${s.totalNet.toFixed(0)}`).join(', ')}`);

  return {
    totalNet,
    totalGross,
    supplierTotals,
    revenueByDate,
    entryCount: entries.length,
  };
}

// ── Feldschlösschen-Historie (Teil C: Jahres-Import aus Sammelrechnungen) ────
// Ein KV-Blob pro Jahr+Mandant: Record<SammelNr, FsHistorienEintrag> —
// dublettensicher (Upsert auf Sammelrechnung-Nr). Jahr-Sperre separat, wird im
// Save-Pfad IMMER frisch gelesen (nie nur UI-State).

const fsHistorieKey = (tenantId: TenantId, jahr: string) => tenantKey(tenantId, `fs_historie_${jahr}_v1`);
const fsHistorieLockKey = (tenantId: TenantId) => tenantKey(tenantId, 'fs_historie_lock_v1');

export async function loadFsHistorie(
  tenantId: TenantId, jahr: string,
): Promise<Record<string, import('./feldschloesschen').FsHistorienEintrag>> {
  try {
    const raw = await kvGet(fsHistorieKey(tenantId, jahr));
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, import('./feldschloesschen').FsHistorienEintrag>
      : {};
  } catch { return {}; }
}

/**
 * Upsert je Sammelrechnung-Nr. Wirft, wenn das Jahr gesperrt ist — der Lock
 * wird hier FRISCH gelesen (Vorjahr-Hardzahlen-Muster).
 */
export async function upsertFsHistorie(
  tenantId: TenantId, jahr: string,
  eintraege: Array<import('./feldschloesschen').FsHistorienEintrag>,
): Promise<{ neu: number; ersetzt: number }> {
  if (await isFsHistorieLocked(tenantId, jahr)) {
    throw new Error(`Feldschlösschen-Historie ${jahr} ist gesperrt — Sperre zuerst aufheben.`);
  }
  const bestand = await loadFsHistorie(tenantId, jahr);
  let neu = 0, ersetzt = 0;
  for (const e of eintraege) {
    if (!e.sammelNr) continue;
    if (bestand[e.sammelNr]) ersetzt++; else neu++;
    bestand[e.sammelNr] = e;
  }
  await kvSet(fsHistorieKey(tenantId, jahr), bestand);
  return { neu, ersetzt };
}

export async function isFsHistorieLocked(tenantId: TenantId, jahr: string): Promise<boolean> {
  try {
    const raw = await kvGet(fsHistorieLockKey(tenantId));
    return !!(raw && typeof raw === 'object' && (raw as Record<string, unknown>)[jahr] === true);
  } catch (e) {
    // Lesefehler ≠ entsperrt — im Zweifel blockieren
    throw new Error(`Sperr-Status nicht lesbar: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function setFsHistorieLock(tenantId: TenantId, jahr: string, locked: boolean): Promise<void> {
  let cur: Record<string, boolean> = {};
  try {
    const raw = await kvGet(fsHistorieLockKey(tenantId));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) cur = raw as Record<string, boolean>;
  } catch { /* Neuaufbau */ }
  cur[jahr] = locked;
  await kvSet(fsHistorieLockKey(tenantId), cur);
}

// ─── Markt → Lieferant (CSV-Import Transgourmet/Prodega, pro Mandant) ────────

export async function loadMarktLieferantenMapping(tenantId: TenantId): Promise<import('./waren-positionen').MarktLieferantenMapping> {
  const { normalizeMarktLieferantenMapping, DEFAULT_MARKT_LIEFERANTEN } = await import('./waren-positionen');
  try {
    const raw = await kvGet(tenantKey(tenantId, 'waren_markt_lieferanten_v1'));
    return raw === null || raw === undefined ? DEFAULT_MARKT_LIEFERANTEN : normalizeMarktLieferantenMapping(raw);
  } catch {
    const { DEFAULT_MARKT_LIEFERANTEN: def } = await import('./waren-positionen');
    return def;
  }
}

export async function saveMarktLieferantenMapping(tenantId: TenantId, mapping: import('./waren-positionen').MarktLieferantenMapping): Promise<void> {
  await kvSet(tenantKey(tenantId, 'waren_markt_lieferanten_v1'), mapping);
}

// ─── «Letzter Import rückgängig machen» (Warenrechnungs-Importe) ─────────────
// Pro Mandant und Import-Typ genau EIN Undo-Slot (der jeweils letzte Import).
// Snapshot VOR dem Schreiben (vorher) + NACH dem Schreiben (nachher):
// Undo verweigert sauber, wenn der aktuelle Stand nicht mehr «nachher»
// entspricht (zwischenzeitliche manuelle Edits werden nie überschrieben).

export type WarenImportTyp = 'csv' | 'fs' | 'fs_historie' | 'pdf_profil';

export interface WarenImportSnapshot {
  /** supplier_invoices_YYYY-MM pro betroffenem Monat */
  invoicesProMonat: Record<string, InvoiceEntry[]>;
  /** waren_positionen_<monat>_v1 pro betroffenem Monat */
  positionenProMonat: Record<string, unknown>;
  /** waren_preishinweise_<monat>_v1 pro betroffenem Monat */
  hinweiseProMonat: Record<string, unknown>;
  /** waren_preishistorie_v1 (nur wenn der Import sie verändert) */
  preisHistorie?: unknown;
  /** fs_historie_<jahr>_v1 pro betroffenem Jahr (nur Historien-Import) */
  fsHistorieProJahr?: Record<string, unknown>;
}

export interface WarenImportUndoRecord {
  typ: WarenImportTyp;
  zeitpunkt: string;        // ISO
  label: string;            // z.B. «CSV Transgourmet/Prodega»
  anzahlRechnungen: number;
  vorher: WarenImportSnapshot;
  nachher: WarenImportSnapshot;
}

const importUndoKey = (tenantId: TenantId, typ: WarenImportTyp) =>
  tenantKey(tenantId, `waren_import_undo_${typ}_v1`);
const preisHistorieRawKey = (tenantId: TenantId) => tenantKey(tenantId, 'waren_preishistorie_v1');

/** Liest den betroffenen Datenbestand (Monate/Jahre) frisch aus dem KV. */
export async function erstelleWarenImportSnapshot(
  tenantId: TenantId,
  scope: { monate: string[]; mitPreisHistorie?: boolean; jahre?: string[] },
): Promise<WarenImportSnapshot> {
  const snap: WarenImportSnapshot = { invoicesProMonat: {}, positionenProMonat: {}, hinweiseProMonat: {} };
  for (const m of [...new Set(scope.monate)]) {
    snap.invoicesProMonat[m] = await loadMonthInvoices(tenantId, m);
    snap.positionenProMonat[m] = (await kvGet(tenantKey(tenantId, `waren_positionen_${m}_v1`))) ?? null;
    snap.hinweiseProMonat[m] = (await kvGet(tenantKey(tenantId, `waren_preishinweise_${m}_v1`))) ?? null;
  }
  if (scope.mitPreisHistorie) snap.preisHistorie = (await kvGet(preisHistorieRawKey(tenantId))) ?? null;
  if (scope.jahre && scope.jahre.length > 0) {
    snap.fsHistorieProJahr = {};
    for (const j of [...new Set(scope.jahre)]) {
      snap.fsHistorieProJahr[j] = (await kvGet(fsHistorieKey(tenantId, j))) ?? null;
    }
  }
  return snap;
}

export async function saveWarenImportUndo(tenantId: TenantId, record: WarenImportUndoRecord): Promise<void> {
  await kvSet(importUndoKey(tenantId, record.typ), record);
}

export async function loadWarenImportUndo(tenantId: TenantId, typ: WarenImportTyp): Promise<WarenImportUndoRecord | null> {
  try {
    const raw = await kvGet(importUndoKey(tenantId, typ));
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as WarenImportUndoRecord;
    return r.vorher && r.nachher && r.zeitpunkt ? r : null;
  } catch { return null; }
}

/** Stabiler Vergleich (Schlüssel sortiert), damit Property-Reihenfolge nie zählt. */
function stabileSerialisierung(v: unknown): string {
  const sortiere = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sortiere);
    if (x && typeof x === 'object') {
      return Object.fromEntries(Object.keys(x as Record<string, unknown>).sort()
        .map(k => [k, sortiere((x as Record<string, unknown>)[k])]));
    }
    return x;
  };
  return JSON.stringify(sortiere(v ?? null));
}

/**
 * Macht den letzten Import dieses Typs rückgängig — stellt EXAKT den Stand vor
 * dem Import wieder her. Wirft mit klarer Meldung wenn:
 * - kein Undo-Datensatz existiert,
 * - der Bestand seit dem Import manuell verändert wurde (Konfliktschutz),
 * - ein betroffenes Historien-Jahr gesperrt ist (Jahr-Sperre bleibt aktiv).
 */
export async function undoWarenImport(tenantId: TenantId, typ: WarenImportTyp): Promise<WarenImportUndoRecord> {
  const rec = await loadWarenImportUndo(tenantId, typ);
  if (!rec) throw new Error('Kein rückgängig machbarer Import vorhanden.');

  const jahre = rec.nachher.fsHistorieProJahr ? Object.keys(rec.nachher.fsHistorieProJahr) : [];
  // Jahr-Sperre IM Undo-Pfad frisch prüfen (nie nur UI-State)
  for (const j of jahre) {
    if (await isFsHistorieLocked(tenantId, j)) {
      throw new Error(`Historie ${j} ist gesperrt — Undo nicht möglich, Sperre zuerst aufheben.`);
    }
  }

  // Konfliktschutz: aktueller Stand muss dem Stand DIREKT NACH dem Import entsprechen.
  const aktuell = await erstelleWarenImportSnapshot(tenantId, {
    monate: Object.keys(rec.nachher.invoicesProMonat),
    mitPreisHistorie: rec.nachher.preisHistorie !== undefined,
    jahre,
  });
  if (stabileSerialisierung(aktuell) !== stabileSerialisierung(rec.nachher)) {
    throw new Error('Seit dem Import wurde manuell geändert — Undo verweigert, damit nichts überschrieben wird. Bitte manuell korrigieren.');
  }

  // Doppel-Undo-Wache (z.B. zwei Tabs): Slot frisch nachlesen — muss noch
  // exakt DERSELBE Import sein. Bekannte Grenze: der KV-Store bietet kein
  // echtes Compare-and-Swap; ein Schreibkonflikt im Millisekunden-Fenster
  // zwischen Prüfung und Restore ist theoretisch möglich (wie bei den übrigen
  // Undo-Pfaden dieser App, Import-Center-Protokoll).
  const slotFrisch = await loadWarenImportUndo(tenantId, typ);
  if (!slotFrisch || slotFrisch.zeitpunkt !== rec.zeitpunkt || slotFrisch.typ !== rec.typ) {
    throw new Error('Undo-Datensatz wurde zwischenzeitlich ersetzt oder bereits verwendet — Undo abgebrochen.');
  }

  // Stand VOR dem Import zurückschreiben.
  for (const [m, invoices] of Object.entries(rec.vorher.invoicesProMonat)) {
    await kvSet(invoicesKey(tenantId, m), invoices);
  }
  for (const [m, pos] of Object.entries(rec.vorher.positionenProMonat)) {
    await kvSet(tenantKey(tenantId, `waren_positionen_${m}_v1`), pos ?? {});
  }
  for (const [m, hin] of Object.entries(rec.vorher.hinweiseProMonat)) {
    await kvSet(tenantKey(tenantId, `waren_preishinweise_${m}_v1`), hin ?? {});
  }
  if (rec.vorher.preisHistorie !== undefined) {
    await kvSet(preisHistorieRawKey(tenantId), rec.vorher.preisHistorie ?? {});
  }
  if (rec.vorher.fsHistorieProJahr) {
    for (const [j, blob] of Object.entries(rec.vorher.fsHistorieProJahr)) {
      await kvSet(fsHistorieKey(tenantId, j), blob ?? {});
    }
  }
  // Slot leeren — nur der JEWEILS LETZTE Import ist rückgängig machbar.
  await kvSet(importUndoKey(tenantId, typ), null);
  return rec;
}
