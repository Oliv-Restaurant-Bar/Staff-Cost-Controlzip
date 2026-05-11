/**
 * Contract History Store
 * ======================
 * Speichert die Vertragshistorie eines Mitarbeiters (Wechsel Stunden-/Monatslohn)
 * in localStorage mit Supabase-KV-Backup.
 *
 * Schlüssel: tenantKey('contractHistory') → Record<empId, ContractPhase[]>
 */

import { saveSetting } from '@/lib/supabase-db';
import type { EmploymentType } from '@/types/personnel';

// ─── Typen ───────────────────────────────────────────────────────────────────

export interface ContractPhase {
  /** Eindeutige ID dieser Phase (UUID-artig) */
  id: string;
  /** Gültig ab (ISO-Datum "YYYY-MM-DD") */
  effectiveFrom: string;
  /** Gültig bis (ISO-Datum, exklusiv) — wird beim nächsten Wechsel gesetzt */
  effectiveTo?: string;
  /** Vertragsart */
  contractType: 'monthly' | 'hourly' | 'irregular';
  /** Beschäftigungsgrad */
  employmentType: EmploymentType;
  /** Monatslohn brutto (ohne 13.) */
  monthlySalary?: number;
  /** Monatslohn inkl. 13. Monatslohn */
  monthlySalaryWith13th?: number;
  /** Stundenlohn brutto */
  hourlyWage?: number;
  /** Wochenstunden */
  weeklyHours?: number;
  /** 13. Monatslohn vereinbart? */
  has13thSalary?: boolean;
  /** AG-Sozialkostenfaktor (z.B. 1.13) */
  socialCostFactor?: number;
  /** Optionale Notiz (z.B. "Beförderung", "Pensumsreduktion") */
  note?: string;
  /** Erstellt am (ISO-Timestamp) */
  createdAt: string;
}

export type ContractHistoryMap = Record<string, ContractPhase[]>;

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function storageKey(tenantKeyFn: (k: string) => string): string {
  return tenantKeyFn('contractHistory');
}

// ─── Lesen ───────────────────────────────────────────────────────────────────

export function loadAllContractHistory(
  tenantKeyFn: (k: string) => string,
): ContractHistoryMap {
  try {
    const raw = localStorage.getItem(storageKey(tenantKeyFn));
    if (!raw) return {};
    return JSON.parse(raw) as ContractHistoryMap;
  } catch {
    return {};
  }
}

export function loadContractHistory(
  tenantKeyFn: (k: string) => string,
  empId: string,
): ContractPhase[] {
  const map = loadAllContractHistory(tenantKeyFn);
  const phases = map[empId] ?? [];
  // newest first
  return [...phases].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
}

// ─── Schreiben ────────────────────────────────────────────────────────────────

/**
 * Archiviert eine neue Vertragsphase für einen Mitarbeiter.
 * Setzt den `effectiveTo` der vorherigen Phase auf den Tag vor `phase.effectiveFrom`.
 */
export function archiveContractPhase(
  tenantKeyFn: (k: string) => string,
  empId: string,
  phase: Omit<ContractPhase, 'id' | 'createdAt'>,
): ContractPhase {
  const newPhase: ContractPhase = {
    ...phase,
    id: makeId(),
    createdAt: new Date().toISOString(),
  };

  const map = loadAllContractHistory(tenantKeyFn);
  const existing = (map[empId] ?? []).map(p => {
    // Schliesse die vorherige offene Phase ab
    if (!p.effectiveTo && p.effectiveFrom < phase.effectiveFrom) {
      const before = new Date(phase.effectiveFrom + 'T00:00:00');
      before.setDate(before.getDate() - 1);
      return { ...p, effectiveTo: before.toISOString().slice(0, 10) };
    }
    return p;
  });

  map[empId] = [...existing, newPhase].sort(
    (a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom),
  );

  try {
    localStorage.setItem(storageKey(tenantKeyFn), JSON.stringify(map));
    // Async Supabase backup — non-blocking
    saveSetting(storageKey(tenantKeyFn), map).catch(e =>
      console.error('[contractHistory] Supabase backup failed:', e),
    );
  } catch (e) {
    console.error('[contractHistory] localStorage write failed:', e);
  }

  return newPhase;
}

// ─── Analyse ─────────────────────────────────────────────────────────────────

/**
 * Gibt die Vertragsphase zurück, die für ein bestimmtes ISO-Datum gültig war.
 */
export function getPhaseAt(phases: ContractPhase[], date: string): ContractPhase | null {
  const sorted = [...phases].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  return sorted.find(p =>
    p.effectiveFrom <= date && (!p.effectiveTo || p.effectiveTo >= date),
  ) ?? null;
}

/**
 * Prüft ob ein Mitarbeiter IM angegebenen Monat einen Vertragswechsel hatte.
 * Gibt die NEUE Phase zurück (nicht die alte).
 * effectiveFrom muss im angegebenen Monat liegen UND darf nicht der 1. sein.
 */
export function getMidMonthSwitchInMonth(
  phases: ContractPhase[],
  year: number,
  month: number,
): ContractPhase | null {
  const prefix = `${year}-${String(month).padStart(2, '0')}-`;
  return phases.find(p =>
    p.effectiveFrom.startsWith(prefix) && !p.effectiveFrom.endsWith('-01'),
  ) ?? null;
}

/**
 * Gibt den "aktiven" (neuesten, noch offenen) Vertrag zurück.
 */
export function getActivePhase(phases: ContractPhase[]): ContractPhase | null {
  const sorted = [...phases].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  return sorted.find(p => !p.effectiveTo) ?? sorted[0] ?? null;
}

/**
 * Erstellt eine ContractPhase aus einem Employee-Objekt (für die Archivierung).
 */
export function phaseFromEmployee(
  emp: {
    contractType?: string;
    employmentType: EmploymentType;
    monthlySalary?: number;
    monthlySalaryWith13th?: number;
    hourlyWage?: number;
    weeklyHours?: number;
    has13thSalary?: boolean;
    socialCostFactor?: number;
  },
  effectiveTo?: string,
): Omit<ContractPhase, 'id' | 'createdAt' | 'effectiveFrom'> {
  return {
    effectiveTo,
    contractType: (emp.contractType as ContractPhase['contractType']) ?? 'hourly',
    employmentType: emp.employmentType,
    monthlySalary: emp.monthlySalary,
    monthlySalaryWith13th: emp.monthlySalaryWith13th,
    hourlyWage: emp.hourlyWage,
    weeklyHours: emp.weeklyHours,
    has13thSalary: emp.has13thSalary,
    socialCostFactor: emp.socialCostFactor,
  };
}
