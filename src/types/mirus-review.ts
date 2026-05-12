/**
 * Mirus Review — Typen
 * ====================
 * Datenstrukturen für den Review-Workflow.
 * KEIN Supabase-Write — rein lokaler State.
 */

import type { PreviewImportSession, PreviewShift } from './mirus-import-preview';

export type ReviewAction    = 'accepted' | 'held' | 'excluded' | 'correction_needed';
export type ReviewStatus    = 'preview' | 'in_review' | 'approved' | 'distributed' | 'archived';
export type DistributionStatus = 'not_sent' | 'sent' | 'disputed' | 'confirmed';

export interface AuditEntry {
  id:        string;
  who:       string;
  when:      string;  // ISO timestamp
  what:      string;
  comment:   string;
  field?:    string;
  oldValue?: string;
  newValue?: string;
}

export interface DayOverride {
  date:         string;
  shifts:       PreviewShift[];
  breakMinutes: number | null;
  absenceCode:  string | null;
  notes:        string | null;
  comment:      string;  // Pflichtfeld
}

export interface ReviewEmployeeState {
  tempId:          string;
  action:          ReviewAction | null;
  matchedName:     string | null;  // manuell zugeordneter Personalstamm-Name
  rememberMatch:   boolean;
  comment:         string;
  dayOverrides:    Record<string, DayOverride>;  // date → override
  distributionStatus: DistributionStatus;
  auditLog:        AuditEntry[];
}

export interface ReviewState {
  session:         PreviewImportSession;
  reviewStatus:    ReviewStatus;
  employeeStates:  Record<string, ReviewEmployeeState>;
  globalComment:   string;
  globalAuditLog:  AuditEntry[];
  createdAt:       string;
  updatedAt:       string;
}

// ── Hilfsfunktionen ──────────────────────────────────────────────────────────

export function makeAuditEntry(who: string, what: string, comment = '', extra?: Partial<AuditEntry>): AuditEntry {
  return { id: `audit-${Date.now()}-${Math.random().toString(36).slice(2,6)}`, who, when: new Date().toISOString(), what, comment, ...extra };
}

export function initEmployeeState(tempId: string): ReviewEmployeeState {
  return { tempId, action: null, matchedName: null, rememberMatch: false, comment: '', dayOverrides: {}, distributionStatus: 'not_sent', auditLog: [] };
}

export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  preview:     'Vorschau',
  in_review:   'In Prüfung',
  approved:    'Freigegeben',
  distributed: 'Verteilt',
  archived:    'Archiviert',
};

export const DISTRIBUTION_STATUS_LABELS: Record<DistributionStatus, string> = {
  not_sent:  'Nicht gesendet',
  sent:      'Gesendet',
  disputed:  'Beanstandet',
  confirmed: 'Bestätigt',
};
