/**
 * crm-auswertung-url — View-State ⇄ URL für die CRM-Auswertung
 * =============================================================
 * Reine Logik (KEIN supabase / KEIN DOM), damit der Zustand der CRM-Auswertung
 * (aktiver Reiter, gewählte Zukunfts-Kachel, individueller Zeitraum + Auswahl,
 * geöffnete Kampagne) in der URL gespiegelt werden kann.  Dadurch:
 *
 *  1. ist die Seite per URL teil- und aktualisierbar (refresh-fest), und
 *  2. kann beim Sprung in ein Gästeprofil die GENAUE Rückkehr-URL als
 *     `?from=…` mitgegeben werden, sodass der „Zurück zur CRM-Auswertung“-
 *     Button exakt denselben Zustand wiederherstellt.
 *
 * `parseFromParam` validiert die `from`-URL streng (nur die interne
 * CRM-Auswertungsroute) und verhindert so Open-Redirects.
 */

import type { FutureSelectionKey, RangeSelectionKind } from './reservation-dashboard';

export type CrmTab = 'overview' | 'return' | 'campaigns';

/** In der URL gespiegelter Anzeigezustand der CRM-Auswertung. */
export interface CrmViewState {
  tab: CrmTab;
  future: FutureSelectionKey | null;
  rangeFrom: string | null;
  rangeTo: string | null;
  rangeSel: RangeSelectionKind | null;
  /** Kampagnen-ID (opak — die Seite validiert gegen CAMPAIGN_BY_ID). */
  campaign: string | null;
}

/** Route der CRM-Auswertung (einziges erlaubtes `from`-Ziel). */
export const CRM_AUSWERTUNG_PATH = '/gaeste/auswertung';

export const EMPTY_CRM_VIEW_STATE: CrmViewState = {
  tab: 'overview',
  future: null,
  rangeFrom: null,
  rangeTo: null,
  rangeSel: null,
  campaign: null,
};

const CRM_TABS: readonly CrmTab[] = ['overview', 'return', 'campaigns'];
const FUTURE_KEYS: readonly FutureSelectionKey[] = [
  'currentMonth', 'nextMonth', 'next30', 'next60', 'next90', 'openNext90',
];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function asTab(v: string | null): CrmTab {
  return CRM_TABS.includes(v as CrmTab) ? (v as CrmTab) : 'overview';
}

function asFuture(v: string | null): FutureSelectionKey | null {
  return v && FUTURE_KEYS.includes(v as FutureSelectionKey) ? (v as FutureSelectionKey) : null;
}

function asRangeSel(v: string | null): RangeSelectionKind | null {
  return v === 'active' || v === 'open' ? v : null;
}

function asDate(v: string | null): string | null {
  return v && DATE_RE.test(v) ? v : null;
}

/**
 * Liest den Anzeigezustand aus den URL-Parametern.  Ungültige Werte fallen auf
 * sichere Defaults zurück.  Der individuelle Zeitraum (`rfrom`/`rto`) wird NUR
 * berücksichtigt, wenn eine Auswahl (`rsel`) gesetzt ist UND beide Datumswerte
 * gültig sind — sonst wird die Zeitraum-Auswahl komplett verworfen.
 */
export function parseCrmViewState(params: URLSearchParams): CrmViewState {
  const rangeSel = asRangeSel(params.get('rsel'));
  const rangeFrom = rangeSel ? asDate(params.get('rfrom')) : null;
  const rangeTo = rangeSel ? asDate(params.get('rto')) : null;
  const hasRange = rangeSel !== null && rangeFrom !== null && rangeTo !== null;
  return {
    tab: asTab(params.get('tab')),
    future: asFuture(params.get('future')),
    rangeSel: hasRange ? rangeSel : null,
    rangeFrom: hasRange ? rangeFrom : null,
    rangeTo: hasRange ? rangeTo : null,
    campaign: params.get('campaign') || null,
  };
}

/**
 * Serialisiert den Anzeigezustand in URL-Parameter.  Defaults werden
 * weggelassen (sauberere URLs): `tab=overview`, leere Felder und ein
 * unvollständiger Zeitraum (ohne Auswahl oder ohne beide Datumswerte).
 */
export function crmViewStateToParams(state: CrmViewState): URLSearchParams {
  const p = new URLSearchParams();
  if (state.tab && state.tab !== 'overview') p.set('tab', state.tab);
  if (state.future) p.set('future', state.future);
  if (state.campaign) p.set('campaign', state.campaign);
  if (state.rangeSel && state.rangeFrom && state.rangeTo) {
    p.set('rsel', state.rangeSel);
    p.set('rfrom', state.rangeFrom);
    p.set('rto', state.rangeTo);
  }
  return p;
}

/** Vollständige interne Rückkehr-URL der CRM-Auswertung für den aktuellen Zustand. */
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
 * die interne CRM-Auswertungsroute und gibt nur `pathname + search` zurück.
 * Wehrt Open-Redirects ab (absolute/protokoll-relative URLs, Fremdpfade,
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
  // … und exakt die CRM-Auswertungsroute treffen (keine Unterpfade).
  if (url.pathname !== CRM_AUSWERTUNG_PATH) return null;
  return url.pathname + url.search;
}
