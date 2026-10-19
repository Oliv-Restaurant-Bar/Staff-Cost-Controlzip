/**
 * useMaisonExclude — globaler synchroner Toggle
 * ================================================
 * Steuert ob Marketing-Umsatz zum Gesamtumsatz dazugezählt wird.
 * true  = Marketing wird NICHT zum Umsatz gezählt
 * false = Marketing wird zum Umsatz gezählt (Default)
 *
 * Alle Komponenten in derselben Tab-Sitzung werden über
 * ein CustomEvent sofort synchronisiert.
 */

import { useState, useEffect } from 'react';

const LS_KEY     = 'maison-exclude-revenue';
const EVENT_NAME = 'maison-exclude-changed';

export function getMaisonExcludeSync(): boolean {
  try { return localStorage.getItem(LS_KEY) === 'true'; } catch { return false; }
}

export function setMaisonExcludeGlobal(val: boolean): void {
  try { localStorage.setItem(LS_KEY, String(val)); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: val }));
}

export function useMaisonExclude(): [boolean, (val: boolean) => void] {
  const [exclude, setExclude] = useState<boolean>(getMaisonExcludeSync);

  useEffect(() => {
    const handler = (e: Event) => setExclude((e as CustomEvent<boolean>).detail);
    window.addEventListener(EVENT_NAME, handler);
    return () => window.removeEventListener(EVENT_NAME, handler);
  }, []);

  return [exclude, setMaisonExcludeGlobal];
}
