/**
 * crm-auswertung-url — View-State ⇄ URL für „Gäste & Reservationen"
 * =================================================================
 * Reine Logik (KEIN supabase / KEIN DOM), damit der Anzeigezustand der Seite
 * „Gäste & Reservationen" (aktiver CRM-Reiter, gewählter Zeitraum der
 * Zukunftsübersicht, geöffnete Kampagne) in der URL gespiegelt werden kann.
 * Dadurch:
 *
 *  1. ist die Seite per URL teil- und aktualisierbar (refresh-fest), und
 *  2. kann beim Sprung in ein Gästeprofil die GENAUE Rückkehr-URL als
 *     `?from=…` mitgegeben werden, sodass der „Zurück"-Button exakt denselben
 *     Zustand wiederherstellt.
 *
 * `parseFromParam` validiert die `from`-URL streng (nur die interne Route) und
 * verhindert so Open-Redirects.
 *
 * Der Zeitraum nutzt DIESELBE `FutureRangeKind`-Schnellauswahl wie die
 * Zukunftsübersicht (foratable-future.ts) — es gibt keine zweite Zeitraum-Logik.
 */

import type { FutureRangeKind } from './foratable-future';

export type CrmTab = 'overview' | 'return' | 'campaigns';

/** In der URL gespiegelter Anzeigezustand von „Gäste & Reservationen". */
export interface CrmViewState {
  tab: CrmTab;
  /** Zeitraum-Schnellauswahl der Zukunftsübersicht (Default: laufender Monat). */
  rangeKind: FutureRangeKind;
  /** Individueller Zeitraum — NUR bei `rangeKind === 'custom'` gesetzt. */
  rangeFrom: string | null;
  rangeTo: string | null;
  /** Kampagnen-ID (opak — die Seite validiert gegen CAMPAIGN_BY_ID). */
  campaign: string | null;
}

/** Route der Seite (einziges erlaubtes `from`-Ziel). */
export const CRM_AUSWERTUNG_PATH = '/gaeste/auswertung';

export const EMPTY_CRM_VIEW_STATE: CrmViewState = {
  tab: 'overview',
  rangeKind: 'current-month',
  rangeFrom: null,
  rangeTo: null,
  campaign: null,
};

const CRM_TABS: readonly CrmTab[] = ['overview', 'return', 'campaigns'];
const RANGE_KINDS: readonly FutureRangeKind[] = [
  'current-month', 'next-7', 'next-14', 'next-30', 'custom',
];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function asTab(v: string | null): CrmTab {
  return CRM_TABS.includes(v as CrmTab) ? (v as CrmTab) : 'overview';
}

function asRangeKind(v: string | null): FutureRangeKind {
  return v && RANGE_KINDS.includes(v as FutureRangeKind)
    ? (v as FutureRangeKind)
    : 'current-month';
}

function asDate(v: string | null): string | null {
  return v && DATE_RE.test(v) ? v : null;
}

/**
 * Liest den Anzeigezustand aus den URL-Parametern.  Ungültige Werte fallen auf
 * sichere Defaults zurück.  Ein individueller Zeitraum (`range=custom`) wird NUR
 * übernommen, wenn beide Datumswerte (`rfrom`/`rto`) gültig sind — sonst fällt
 * der Zeitraum auf den laufenden Monat zurück.
 */
export function parseCrmViewState(params: URLSearchParams): CrmViewState {
  const rangeKind = asRangeKind(params.get('range'));
  const isCustom = rangeKind === 'custom';
  const rangeFrom = isCustom ? asDate(params.get('rfrom')) : null;
  const rangeTo = isCustom ? asDate(params.get('rto')) : null;
  const customValid = isCustom && rangeFrom !== null && rangeTo !== null;
  return {
    tab: asTab(params.get('tab')),
    rangeKind: isCustom ? (customValid ? 'custom' : 'current-month') : rangeKind,
    rangeFrom: customValid ? rangeFrom : null,
    rangeTo: customValid ? rangeTo : null,
    campaign: params.get('campaign') || null,
  };
}

/**
 * Serialisiert den Anzeigezustand in URL-Parameter.  Defaults werden
 * weggelassen (sauberere URLs): `tab=overview`, `range=current-month`, leere
 * Kampagne und ein unvollständiger individueller Zeitraum.
 */
export function crmViewStateToParams(state: CrmViewState): URLSearchParams {
  const p = new URLSearchParams();
  if (state.tab && state.tab !== 'overview') p.set('tab', state.tab);
  if (state.rangeKind === 'custom' && state.rangeFrom && state.rangeTo) {
    p.set('range', 'custom');
    p.set('rfrom', state.rangeFrom);
    p.set('rto', state.rangeTo);
  } else if (state.rangeKind !== 'current-month' && state.rangeKind !== 'custom') {
    p.set('range', state.rangeKind);
  }
  if (state.campaign) p.set('campaign', state.campaign);
  return p;
}

/** Vollständige interne Rückkehr-URL der Seite für den aktuellen Zustand. */
export function crmReturnUrl(state: CrmViewState): string {
  const qs = crmViewStateToParams(state).toString();
  return qs ? `${CRM_AUSWERTUNG_PATH}?${qs}` : CRM_AUSWERTUNG_PATH;
}

/**
 * URL zum Gästeprofil, optional mit Rückkehrziel.  Das `from`-Ziel wird
 * encodiert, damit seine eigenen Query-Parameter nicht mit dem äusseren
 * Query-String kollidieren.
 */
export function buildGuestHref(guestId: string, fromUrl?: string | null): string {
  const base = `/gaeste/${encodeURIComponent(guestId)}`;
  return fromUrl ? `${base}?from=${encodeURIComponent(fromUrl)}` : base;
}

// Synthetischer Origin nur zum Parsen/Validieren relativer `from`-Pfade.
const SAFE_BASE = 'https://crm.local.invalid';

/**
 * Liest und validiert das `from`-Rückkehrziel STRENG: akzeptiert ausschliesslich
 * die interne Route und gibt nur `pathname + search` zurück.  Wehrt
 * Open-Redirects ab (absolute/protokoll-relative URLs, Fremdpfade,
 * Backslashes/Steuerzeichen → null).
 */
export function parseFromParam(params: URLSearchParams): string | null {
  const raw = params.get('from');
  if (!raw) return null;
  // Backslashes / Steuerzeichen vorab ablehnen (gegen abweichende Normalisierung).
  if (/[\\\x00-\x1f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, SAFE_BASE);
  } catch {
    return null;
  }
  // Muss auf unserem synthetischen Origin landen (also intern/relativ sein) …
  if (url.origin !== SAFE_BASE) return null;
  // … und exakt die Route treffen (keine Unterpfade).
  if (url.pathname !== CRM_AUSWERTUNG_PATH) return null;
  return url.pathname + url.search;
}
