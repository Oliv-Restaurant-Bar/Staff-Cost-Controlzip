/**
 * monat-param — zentraler Monats-Kontext für KPI-Drilldowns (reine Logik, DOM-frei).
 *
 * Das Management-KPI-Dashboard (Startseite) reicht den gewählten Monat per
 * URL-Parameter `?monat=YYYY-MM` an die Ebene-2/3-Zielseiten weiter.
 * Hier liegt die EINE Definition:
 *  - welche Routen den Parameter konsumieren (Allow-List, keine blinden Params),
 *  - wie der Parameter gebaut und validiert wird (ungültig ⇒ null, nie raten).
 *
 * /umsatzabstimmung hat einen bestehenden `?year=YYYY`-Vertrag und wird
 * bewusst darüber bedient (kein zweites Param-Schema für dieselbe Seite).
 */

export const MONAT_PARAM = 'monat';

/** Routen, die `?monat=YYYY-MM` beim Laden konsumieren (Monats-/Jahresauswahl). */
const MONAT_ROUTES = new Set<string>([
  '/erfolgsrechnung',
  '/personal-fix',
  '/wes-analyse',
  '/kennzahlen-bericht',
  '/tagesabschluesse',
  '/reporting',
]);

/** Routen mit bestehendem `?year=YYYY`-Vertrag (siehe /umsatzabstimmung). */
const YEAR_ROUTES = new Set<string>(['/umsatzabstimmung']);

export interface MonatParamValue {
  year: number;
  month: number; // 1-12
}

/** `YYYY-MM` bauen (Gegenstück zu parseMonatParam). */
export function formatMonatParam(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * `?monat=YYYY-MM` validierend parsen.
 * Ungültige/fehlende Werte ⇒ null (Zielseite bleibt bei ihrem Default) —
 * nie stilles Raten oder Clamping auf einen anderen Monat.
 */
export function parseMonatParam(raw: string | null | undefined): MonatParamValue | null {
  if (!raw) return null;
  const m = /^(\d{4})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  return { year, month };
}

/**
 * Drilldown-URL für eine Zielroute mit Monats-Kontext bauen.
 * Nur Allow-List-Routen erhalten einen Parameter; alle anderen Routen
 * werden unverändert zurückgegeben (Zielseite hat keinen Monatsbegriff).
 */
export function buildKpiDrilldownUrl(route: string, year: number, month: number): string {
  const sep = route.includes('?') ? '&' : '?';
  if (MONAT_ROUTES.has(route)) return `${route}${sep}${MONAT_PARAM}=${formatMonatParam(year, month)}`;
  if (YEAR_ROUTES.has(route)) return `${route}${sep}year=${year}`;
  return route;
}
