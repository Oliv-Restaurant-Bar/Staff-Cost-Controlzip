/**
 * useEmployerRateMap — zentraler Hook für Kostenrechnungen in Komponenten.
 *
 * Liefert pro Mitarbeiter den AG-Stundenkostensatz (Total Arbeitgeberkosten/h
 * = Bruttolohn + Arbeitgeber-Sozialkosten, zentrale Sätze aus den
 * Einstellungen). Kostenrechnende Komponenten verwenden AUSSCHLIESSLICH
 * diese Map — nie den rohen `hourlyWage`.
 */
import { useMemo } from 'react';
import type { Employee } from '@/types/personnel';
import { useSocialCostRates } from '@/hooks/useSocialCostRates';
import { getEffectiveHourlyRate } from '@/lib/employee-rate';
import type { SocialCostRates } from '@/lib/social-costs';

export interface EmployerRateMap {
  /** MA-ID → Total Arbeitgeberkosten pro Stunde (nur Werte > 0 enthalten). */
  rateById: Map<string, number>;
  /** Zentrale Sätze — für EmployerCostInfoTip/Aufschlüsselung. */
  rates: SocialCostRates;
}

export function useEmployerRateMap(employees: Employee[]): EmployerRateMap {
  const { rates } = useSocialCostRates();
  const rateById = useMemo(() => {
    const m = new Map<string, number>();
    employees.forEach(emp => {
      const r = getEffectiveHourlyRate(emp, rates);
      if (r != null && r > 0) m.set(emp.id, r);
    });
    return m;
  }, [employees, rates]);
  return { rateById, rates };
}
