// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import {
  ScheduleSaveQueue, planSaveKey, istSaveKey, parseSaveKey,
} from '@/lib/schedule-save-queue';

const tick = () => new Promise<void>(r => setTimeout(r, 0));

/** Save-Funktion, deren Promises manuell aufgelöst werden können. */
function deferredSaveFn<T>() {
  const calls: { key: string; payload: T; resolve: () => void; reject: (e: Error) => void }[] = [];
  const fn = (key: string, payload: T) =>
    new Promise<void>((resolve, reject) => {
      calls.push({ key, payload, resolve, reject });
    });
  return { fn, calls };
}

describe('ScheduleSaveQueue: Serialisierung pro Schlüssel', () => {
  it('zweiter enqueue desselben Schlüssels wartet, bis der erste Save fertig ist', async () => {
    const { fn, calls } = deferredSaveFn<string>();
    const q = new ScheduleSaveQueue<string>(fn);

    q.enqueue('k', 'A');
    q.enqueue('k', 'B');
    await tick();
    // Nur EIN Save in-flight — B wartet
    expect(calls.length).toBe(1);
    expect(calls[0].payload).toBe('A');

    calls[0].resolve();
    await tick(); await tick();
    expect(calls.length).toBe(2);
    expect(calls[1].payload).toBe('B');
  });

  it('Koaleszenz: während eines Saves ersetzt die neueste wartende Payload ältere (last-writer-wins)', async () => {
    const { fn, calls } = deferredSaveFn<string>();
    const q = new ScheduleSaveQueue<string>(fn);

    q.enqueue('k', 'A');
    await tick();
    q.enqueue('k', 'B');
    q.enqueue('k', 'C');
    calls[0].resolve();
    await tick(); await tick();

    // B wurde nie gesendet — nur A und C
    expect(calls.map(c => c.payload)).toEqual(['A', 'C']);
  });

  it('verschiedene Schlüssel laufen parallel (2. Schicht blockiert die 1. nicht)', async () => {
    const { fn, calls } = deferredSaveFn<string>();
    const q = new ScheduleSaveQueue<string>(fn);

    q.enqueue(planSaveKey('emp1', '2026-07-14'), 'früh');
    q.enqueue(planSaveKey('emp2', '2026-07-14'), 'spät');
    await tick();
    expect(calls.length).toBe(2);
  });
});

describe('ScheduleSaveQueue: Statusmodell (Backend-Ack)', () => {
  it('lastSavedAt wird erst NACH erfolgreichem Backend-Ack gesetzt', async () => {
    const { fn, calls } = deferredSaveFn<string>();
    const now = new Date('2026-07-14T10:00:00Z');
    const q = new ScheduleSaveQueue<string>(fn, { now: () => now });

    q.enqueue('k', 'A');
    await tick();
    expect(q.getSnapshot().lastSavedAt).toBeNull();
    expect(q.getSnapshot().isSaving).toBe(true);

    calls[0].resolve();
    await tick(); await tick();
    expect(q.getSnapshot().lastSavedAt).toEqual(now);
    expect(q.getSnapshot().isSaving).toBe(false);
    expect(q.getSnapshot().pendingCount).toBe(0);
  });

  it('Fehler landet in errorCount + errors; hasErrors() true', async () => {
    const { fn, calls } = deferredSaveFn<string>();
    const q = new ScheduleSaveQueue<string>(fn);

    q.enqueue('k', 'A');
    await tick();
    calls[0].reject(new Error('Netzwerkfehler'));
    await tick(); await tick();

    const snap = q.getSnapshot();
    expect(snap.errorCount).toBe(1);
    expect(snap.errors['k']).toBe('Netzwerkfehler');
    expect(q.hasErrors()).toBe(true);
    expect(snap.lastSavedAt).toBeNull();
  });

  it('retryFailed() versucht fehlgeschlagene Payload erneut; Erfolg räumt den Fehler weg', async () => {
    const { fn, calls } = deferredSaveFn<string>();
    const q = new ScheduleSaveQueue<string>(fn);

    q.enqueue('k', 'A');
    await tick();
    calls[0].reject(new Error('kaputt'));
    await tick(); await tick();
    expect(q.hasErrors()).toBe(true);

    q.retryFailed();
    await tick();
    expect(calls.length).toBe(2);
    expect(calls[1].payload).toBe('A');
    calls[1].resolve();
    await tick(); await tick();
    expect(q.hasErrors()).toBe(false);
    expect(q.getSnapshot().errorCount).toBe(0);
  });

  it('neuer enqueue auf fehlgeschlagenem Schlüssel löscht den Fehlerzustand', async () => {
    const { fn, calls } = deferredSaveFn<string>();
    const q = new ScheduleSaveQueue<string>(fn);

    q.enqueue('k', 'A');
    await tick();
    calls[0].reject(new Error('kaputt'));
    await tick(); await tick();
    expect(q.hasErrors()).toBe(true);

    q.enqueue('k', 'B');
    expect(q.hasErrors()).toBe(false);
    await tick();
    calls[1].resolve();
    await tick(); await tick();
    expect(q.getSnapshot().errorCount).toBe(0);
  });

  it('Fehler wird verworfen, wenn während des Saves bereits eine neuere Payload wartet', async () => {
    const { fn, calls } = deferredSaveFn<string>();
    const q = new ScheduleSaveQueue<string>(fn);

    q.enqueue('k', 'A');
    await tick();
    q.enqueue('k', 'B'); // neuere Payload wartet
    calls[0].reject(new Error('alt'));
    await tick(); await tick();

    // Kein Fehler sichtbar — B ersetzt den fehlgeschlagenen Stand
    expect(q.hasErrors()).toBe(false);
    expect(calls.length).toBe(2);
    calls[1].resolve();
    await tick(); await tick();
    expect(q.getSnapshot().pendingCount).toBe(0);
  });

  it('subscribe liefert Snapshots bei Zustandswechseln', async () => {
    const { fn, calls } = deferredSaveFn<string>();
    const q = new ScheduleSaveQueue<string>(fn);
    const seen: boolean[] = [];
    q.subscribe(s => seen.push(s.isSaving));

    q.enqueue('k', 'A');
    await tick();
    calls[0].resolve();
    await tick(); await tick();
    expect(seen[0]).toBe(true);              // beim Einreihen
    expect(seen[seen.length - 1]).toBe(false); // nach Ack
  });
});

describe('ScheduleSaveQueue: flush()', () => {
  it('flush wartet auf laufende Saves und gibt true zurück', async () => {
    const { fn, calls } = deferredSaveFn<string>();
    const q = new ScheduleSaveQueue<string>(fn);

    q.enqueue('k', 'A');
    await tick();
    const flushPromise = q.flush(5000);
    calls[0].resolve();
    await expect(flushPromise).resolves.toBe(true);
  });

  it('flush gibt false zurück, wenn der Timeout abläuft', async () => {
    const { fn } = deferredSaveFn<string>(); // Save bleibt für immer offen
    const q = new ScheduleSaveQueue<string>(fn);

    q.enqueue('k', 'A');
    await tick();
    await expect(q.flush(120)).resolves.toBe(false);
    expect(q.hasPending()).toBe(true);
  });
});

describe('Save-Schlüssel-Helfer', () => {
  it('plan/ist-Schlüssel sind getrennte Namensräume derselben Zelle', () => {
    expect(planSaveKey('e1', '2026-07-14')).not.toBe(istSaveKey('e1', '2026-07-14'));
  });

  it('parseSaveKey liest ns/employeeId/date zurück', () => {
    expect(parseSaveKey(planSaveKey('e1', '2026-07-14'))).toEqual({ ns: 'plan', employeeId: 'e1', date: '2026-07-14' });
    expect(parseSaveKey(istSaveKey('b-emp', '2026-01-31'))).toEqual({ ns: 'ist', employeeId: 'b-emp', date: '2026-01-31' });
    expect(parseSaveKey('unsinn')).toBeNull();
  });
});
