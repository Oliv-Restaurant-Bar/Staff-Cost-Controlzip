/**
 * Dienstplan-Vorschläge («offene Punkte») aus der Bedarf-vs-Plan-Analyse
 * ======================================================================
 * Aus dem Zell-Pop-up (Position × Tag) heraus werden Personen zum EINPLANEN
 * vorgeschlagen (konkrete Person ODER «offener Platz») oder geplante Personen
 * zum STREICHEN vorgemerkt. Vorschläge sind KEINE Dienstplan-Einträge —
 * erst die Bestätigung im Dienstplan erstellt/entfernt den echten Eintrag.
 *
 * Persistenz: app_settings-Blob `schedule_proposals:<tenant>` (gleiches
 * Muster wie mirus-open-hours-store: Laden → Mergen → Upsert, best-effort,
 * nicht atomar). Status-Feld statt Löschen (open/confirmed/rejected) —
 * keine Tombstone-Probleme, Historie bleibt nachvollziehbar.
 *
 * Sicherheit: Vorschläge verändern weder Plan noch Ist noch Kosten.
 * Mandanten-Trennung über den Key (`schedule_proposals:oliv|beaulieu`).
 */
import { appSettingsTable } from '@/lib/app-settings-table';

export type ProposalStatus = 'open' | 'confirmed' | 'rejected';
export type ProposalType = 'add' | 'remove';

export interface SchedulePlanProposal {
  id: string;
  type: ProposalType;
  /** Kalendertag yyyy-MM-dd. */
  date: string;
  positionKey: string;
  positionName: string;
  /** null = «offener Platz» (Person wird erst bei der Bestätigung gewählt; nur type 'add'). */
  employeeId: string | null;
  employeeName: string | null;
  /**
   * Bei Anlage bewusst bestätigte Konfliktwarnung («trotzdem zuteilen»),
   * z.B. «bereits geplant: Service 11:00–14:00» oder «als FE eingetragen».
   */
  conflictNote?: string | null;
  /** Herkunft des Vorschlags (aktuell immer die Analyse). */
  origin: 'bedarf-analyse';
  createdAt: string;
  status: ProposalStatus;
  resolvedAt?: string;
  resolutionNote?: string;
}

export interface ProposalInput {
  type: ProposalType;
  date: string;
  positionKey: string;
  positionName: string;
  employeeId: string | null;
  employeeName: string | null;
  conflictNote?: string | null;
}

const storeKey = (tenantId: string) => `schedule_proposals:${tenantId}`;

function sanitize(raw: unknown): SchedulePlanProposal[] {
  if (!raw || typeof raw !== 'object') return [];
  const list = (raw as { proposals?: unknown }).proposals;
  if (!Array.isArray(list)) return [];
  const out: SchedulePlanProposal[] = [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const q = p as Record<string, unknown>;
    if (typeof q.id !== 'string' || typeof q.date !== 'string' || typeof q.positionKey !== 'string') continue;
    if (q.type !== 'add' && q.type !== 'remove') continue;
    const status = q.status === 'confirmed' || q.status === 'rejected' ? q.status : 'open';
    out.push({
      id: q.id,
      type: q.type,
      date: q.date,
      positionKey: q.positionKey,
      positionName: typeof q.positionName === 'string' ? q.positionName : q.positionKey,
      employeeId: typeof q.employeeId === 'string' ? q.employeeId : null,
      employeeName: typeof q.employeeName === 'string' ? q.employeeName : null,
      conflictNote: typeof q.conflictNote === 'string' ? q.conflictNote : null,
      origin: 'bedarf-analyse',
      createdAt: typeof q.createdAt === 'string' ? q.createdAt : new Date(0).toISOString(),
      status,
      ...(typeof q.resolvedAt === 'string' ? { resolvedAt: q.resolvedAt } : {}),
      ...(typeof q.resolutionNote === 'string' ? { resolutionNote: q.resolutionNote } : {}),
    });
  }
  return out;
}

/**
 * Alle Vorschläge des Mandanten. WIRFT bei Lesefehler — Aufrufer dürfen einen
 * Lesefehler nicht als «keine Vorschläge» interpretieren (Anzeige-Fehler statt
 * falscher leerer Liste).
 */
export async function fetchProposals(tenantId: string): Promise<SchedulePlanProposal[]> {
  const { data, error } = await appSettingsTable()
    .select('value')
    .eq('key', storeKey(tenantId))
    .maybeSingle();
  if (error) throw new Error(`Vorschläge konnten nicht geladen werden: ${error.message}`);
  return sanitize(data?.value);
}

/** Nur offene Vorschläge. */
export async function fetchOpenProposals(tenantId: string): Promise<SchedulePlanProposal[]> {
  return (await fetchProposals(tenantId)).filter((p) => p.status === 'open');
}

async function saveAll(tenantId: string, proposals: SchedulePlanProposal[]): Promise<void> {
  const { error } = await appSettingsTable().upsert(
    { key: storeKey(tenantId), value: { proposals } },
    { onConflict: 'key' },
  );
  if (error) throw new Error(`Vorschläge konnten nicht gespeichert werden: ${error.message}`);
}

/**
 * Neuen Vorschlag anlegen. Identische OFFENE Vorschläge (gleicher Typ, Tag,
 * Position, Person) werden nicht doppelt angelegt (gibt den bestehenden zurück).
 */
export async function addProposal(tenantId: string, input: ProposalInput): Promise<{ proposal: SchedulePlanProposal; created: boolean }> {
  const current = await fetchProposals(tenantId);
  const dup = current.find((p) =>
    p.status === 'open' && p.type === input.type && p.date === input.date
    && p.positionKey === input.positionKey && p.employeeId === (input.employeeId ?? null));
  if (dup) return { proposal: dup, created: false };
  const proposal: SchedulePlanProposal = {
    id: `prop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: input.type,
    date: input.date,
    positionKey: input.positionKey,
    positionName: input.positionName,
    employeeId: input.employeeId ?? null,
    employeeName: input.employeeName ?? null,
    conflictNote: input.conflictNote ?? null,
    origin: 'bedarf-analyse',
    createdAt: new Date().toISOString(),
    status: 'open',
  };
  await saveAll(tenantId, [...current, proposal]);
  return { proposal, created: true };
}

/** Status eines Vorschlags setzen (confirmed/rejected); Eintrag bleibt erhalten. */
export async function setProposalStatus(
  tenantId: string, id: string, status: 'confirmed' | 'rejected', resolutionNote?: string,
): Promise<void> {
  const current = await fetchProposals(tenantId);
  const idx = current.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error('Vorschlag nicht gefunden (evtl. bereits anderweitig erledigt).');
  const next = [...current];
  next[idx] = {
    ...next[idx],
    status,
    resolvedAt: new Date().toISOString(),
    ...(resolutionNote ? { resolutionNote } : {}),
  };
  await saveAll(tenantId, next);
}

/**
 * Bei der Bestätigung eines «offener Platz»-Vorschlags wird die gewählte
 * Person nachgetragen (für Historie/Anzeige) — Teil des Bestätigungspfads.
 */
export async function fillProposalEmployee(
  tenantId: string, id: string, employeeId: string, employeeName: string,
): Promise<void> {
  const current = await fetchProposals(tenantId);
  const idx = current.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error('Vorschlag nicht gefunden.');
  const next = [...current];
  next[idx] = { ...next[idx], employeeId, employeeName };
  await saveAll(tenantId, next);
}
