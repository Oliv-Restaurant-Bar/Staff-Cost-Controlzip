// @vitest-environment node
/**
 * schedule-proposal-store: Vorschläge («offene Punkte») aus der Bedarf-Analyse.
 * app_settings wird durch einen In-Memory-Store gemockt (Muster wie
 * mirus-open-hours-store.test.ts).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mem = new Map<string, unknown>();
let failReads = false;

vi.mock('@/lib/app-settings-table', () => ({
  appSettingsTable: () => ({
    select: () => ({
      eq: (_col: string, key: string) => ({
        maybeSingle: async () => failReads
          ? { data: null, error: { message: 'boom' } }
          : { data: mem.has(key) ? { value: mem.get(key) } : null, error: null },
      }),
    }),
    upsert: async (row: { key: string; value: unknown }) => {
      mem.set(row.key, row.value);
      return { error: null };
    },
  }),
}));

import {
  addProposal, fetchProposals, fetchOpenProposals, setProposalStatus, fillProposalEmployee,
} from '@/lib/schedule-proposal-store';

const T = 'oliv';
const base = {
  type: 'add' as const, date: '2026-08-03', positionKey: 'service',
  positionName: 'Service', employeeId: 'e1', employeeName: 'Anna',
};

beforeEach(() => { mem.clear(); failReads = false; });

describe('schedule-proposal-store', () => {
  it('legt Vorschläge an und liest sie zurück (Status open)', async () => {
    const { proposal, created } = await addProposal(T, base);
    expect(created).toBe(true);
    expect(proposal.status).toBe('open');
    expect(proposal.origin).toBe('bedarf-analyse');
    const open = await fetchOpenProposals(T);
    expect(open).toHaveLength(1);
    expect(open[0].employeeName).toBe('Anna');
  });

  it('dedupliziert identische OFFENE Vorschläge', async () => {
    await addProposal(T, base);
    const { created } = await addProposal(T, base);
    expect(created).toBe(false);
    expect(await fetchProposals(T)).toHaveLength(1);
  });

  it('erlaubt erneuten Vorschlag, wenn der alte erledigt ist', async () => {
    const { proposal } = await addProposal(T, base);
    await setProposalStatus(T, proposal.id, 'rejected');
    const { created } = await addProposal(T, base);
    expect(created).toBe(true);
    expect(await fetchProposals(T)).toHaveLength(2);
    expect(await fetchOpenProposals(T)).toHaveLength(1);
  });

  it('offener Platz (employeeId null) wird bei Bestätigung gefüllt', async () => {
    const { proposal } = await addProposal(T, { ...base, employeeId: null, employeeName: null });
    expect(proposal.employeeId).toBeNull();
    await fillProposalEmployee(T, proposal.id, 'e2', 'Ben');
    const [p] = await fetchProposals(T);
    expect(p.employeeId).toBe('e2');
    expect(p.employeeName).toBe('Ben');
  });

  it('setProposalStatus setzt resolvedAt/resolutionNote, Eintrag bleibt erhalten', async () => {
    const { proposal } = await addProposal(T, base);
    await setProposalStatus(T, proposal.id, 'confirmed', 'Bestätigt: 11:00–14:00');
    const all = await fetchProposals(T);
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('confirmed');
    expect(all[0].resolvedAt).toBeTruthy();
    expect(all[0].resolutionNote).toContain('11:00');
    expect(await fetchOpenProposals(T)).toHaveLength(0);
  });

  it('wirft bei unbekannter id', async () => {
    await expect(setProposalStatus(T, 'nope', 'rejected')).rejects.toThrow();
  });

  it('Mandanten sind getrennt', async () => {
    await addProposal('oliv', base);
    expect(await fetchProposals('beaulieu')).toHaveLength(0);
  });

  it('WIRFT bei Lesefehler statt leerer Liste', async () => {
    failReads = true;
    await expect(fetchProposals(T)).rejects.toThrow(/geladen/);
  });

  it('sanitize verwirft kaputte Einträge und normalisiert Status', async () => {
    mem.set('schedule_proposals:oliv', {
      proposals: [
        { id: 'a', type: 'add', date: '2026-08-01', positionKey: 'service', status: 'weird' },
        { id: 'b', type: 'nope', date: '2026-08-01', positionKey: 'service' },
        'garbage',
      ],
    });
    const all = await fetchProposals(T);
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('open');
    expect(all[0].positionName).toBe('service');
  });
});
