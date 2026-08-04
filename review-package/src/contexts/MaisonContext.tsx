/**
 * MaisonContext — globaler Marketing/Maison Toggle
 * ==================================================
 * Zwei synchronisierte Einstellungen für alle Views:
 *   showMarketingCol — Spalte/Zeile anzeigen oder ausblenden
 *   maisonExclude    — Marketing aus dem Betriebsertrag herausrechnen
 *
 * Der frühere Sidebar-Umschalter (AppNav) wurde entfernt: showMarketingCol
 * ist fix true (Marketing sichtbar). maisonExclude wird weiterhin von
 * Seiten-lokalen Toggles (z.B. Tagesansicht) gesteuert.
 * Alle Pages lesen nur noch aus diesem Context.
 */

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';

const KEY_SHOW  = 'maison-show-col';
const KEY_EXCL  = 'maison-exclude-revenue';
const EVT_EXCL  = 'maison-exclude-changed';

interface MaisonContextType {
  showMarketingCol: boolean;
  setShowMarketingCol: (v: boolean) => void;
  maisonExclude: boolean;
  setMaisonExclude: (v: boolean) => void;
}

const MaisonContext = createContext<MaisonContextType | undefined>(undefined);

export const MaisonProvider = ({ children }: { children: ReactNode }) => {
  // Menü-Umschalter wurde entfernt: Marketing ist fix SICHTBAR (bisheriger
  // Standard). Alte localStorage-Präferenz wird ignoriert und aufgeräumt.
  const [showMarketingCol, setShowMarketingColState] = useState(true);
  useEffect(() => {
    try { localStorage.removeItem(KEY_SHOW); } catch { /* ignore */ }
  }, []);
  const [maisonExclude, setMaisonExcludeState] = useState(
    () => localStorage.getItem(KEY_EXCL) === 'true',
  );

  const setShowMarketingCol = (v: boolean) => {
    setShowMarketingColState(v);
  };

  const setMaisonExclude = (v: boolean) => {
    setMaisonExcludeState(v);
    localStorage.setItem(KEY_EXCL, String(v));
    window.dispatchEvent(new CustomEvent(EVT_EXCL, { detail: v }));
  };

  useEffect(() => {
    const handler = (e: Event) => {
      const val = (e as CustomEvent<boolean>).detail;
      setMaisonExcludeState(val);
      localStorage.setItem(KEY_EXCL, String(val));
    };
    window.addEventListener(EVT_EXCL, handler);
    return () => window.removeEventListener(EVT_EXCL, handler);
  }, []);

  return (
    <MaisonContext.Provider value={{ showMarketingCol, setShowMarketingCol, maisonExclude, setMaisonExclude }}>
      {children}
    </MaisonContext.Provider>
  );
};

export const useMaison = (): MaisonContextType => {
  const ctx = useContext(MaisonContext);
  if (!ctx) throw new Error('useMaison must be used within MaisonProvider');
  return ctx;
};
