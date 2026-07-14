/**
 * StichtagContext
 * ===============
 * Globaler "Stichtag" (Auswertungsdatum) — wenn gesetzt, zeigen alle Seiten
 * nur Daten bis zu diesem Datum an (monatsgenau).
 *
 * Wird in localStorage gespeichert, damit die Auswahl nach Reload erhalten bleibt.
 * Per Klick auf das X-Symbol wird der Stichtag wieder aufgehoben.
 */

import { createContext, useContext, useState, useEffect, ReactNode, useMemo } from 'react';

const STORAGE_KEY = 'stichtag_v1';

export interface StichtagState {
  stichtag: Date | null;
  stichtagYear: number | null;
  stichtagMonth: number | null;
  stichtagDay: number | null;
  isActive: boolean;
  setStichtag: (date: Date | null) => void;
  clearStichtag: () => void;
  /** Prüft ob ein Jahr/Monat vor oder auf dem Stichtag liegt */
  isInScope: (year: number, month: number) => boolean;
  /** Formatiert den Stichtag als "TT.MM.JJJJ" */
  formatted: string | null;
  /** Formatiert als "Monat JJJJ" (z.B. "März 2026") */
  formattedMonthYear: string | null;
}

const MONTH_NAMES = [
  '', 'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

const StichtagContext = createContext<StichtagState | undefined>(undefined);

function loadFromStorage(): Date | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const d = new Date(raw);
    if (isNaN(d.getTime())) return null;
    return d;
  } catch {
    return null;
  }
}

export const StichtagProvider = ({ children }: { children: ReactNode }) => {
  const [stichtag, setStichtagState] = useState<Date | null>(() => loadFromStorage());

  useEffect(() => {
    if (stichtag) {
      localStorage.setItem(STORAGE_KEY, stichtag.toISOString());
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, [stichtag]);

  const setStichtag = (date: Date | null) => setStichtagState(date);
  const clearStichtag = () => setStichtagState(null);

  const derived = useMemo((): StichtagState => {
    const year  = stichtag ? stichtag.getFullYear() : null;
    const month = stichtag ? stichtag.getMonth() + 1 : null;
    const day   = stichtag ? stichtag.getDate() : null;

    const formatted = stichtag
      ? stichtag.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : null;

    const formattedMonthYear = (year && month)
      ? `${MONTH_NAMES[month]} ${year}`
      : null;

    const isInScope = (y: number, m: number): boolean => {
      if (!year || !month) return true;
      if (y < year) return true;
      if (y === year && m <= month) return true;
      return false;
    };

    return {
      stichtag,
      stichtagYear:  year,
      stichtagMonth: month,
      stichtagDay:   day,
      isActive: stichtag !== null,
      setStichtag,
      clearStichtag,
      isInScope,
      formatted,
      formattedMonthYear,
    };
  }, [stichtag]);

  return (
    <StichtagContext.Provider value={derived}>
      {children}
    </StichtagContext.Provider>
  );
};

export const useStichtag = (): StichtagState => {
  const ctx = useContext(StichtagContext);
  if (!ctx) throw new Error('useStichtag must be used within StichtagProvider');
  return ctx;
};
