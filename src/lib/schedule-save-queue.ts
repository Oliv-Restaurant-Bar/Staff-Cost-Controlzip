/**
 * Serialisierte Save-Queue für Dienstplan-/Ist-Schreibvorgänge.
 *
 * Problemklasse: Zwei schnell aufeinanderfolgende Saves derselben Zelle
 * (z. B. Split-Schicht: früh + spät) racen auf Netzwerkebene — der ältere
 * Upsert kann NACH dem neueren landen und dessen Daten überschreiben.
 *
 * Lösung: Pro Schlüssel (z. B. "plan:empId|date") läuft immer höchstens EIN
 * Save. Neue Payloads während eines laufenden Saves ersetzen die wartende
 * Payload (last-writer-wins-Koaleszenz) und werden nach Abschluss gestartet.
 *
 * Status-Modell (für die Header-Anzeige):
 *  - pendingCount > 0  → „Speichert …" (in-flight oder wartend)
 *  - errorCount  > 0   → „Fehler beim Speichern"
 *  - sonst, lastSavedAt gesetzt → „Gespeichert HH:MM" (erst NACH Backend-Ack)
 *
 * Reines Modul: kein DOM, kein Supabase — Save-Funktion wird injiziert.
 */

export interface SaveQueueSnapshot {
  /** Anzahl Schlüssel mit laufendem ODER wartendem Save */
  pendingCount: number;
  /** Anzahl Schlüssel, deren letzter Save fehlgeschlagen ist */
  errorCount: number;
  /** Fehlermeldungen je Schlüssel (nur fehlgeschlagene) */
  errors: Record<string, string>;
  /** Zeitpunkt des letzten erfolgreichen Backend-Acks (null = noch keiner) */
  lastSavedAt: Date | null;
  /** true solange irgendein Save läuft oder wartet */
  isSaving: boolean;
}

export type SaveFn<T> = (key: string, payload: T) => Promise<void>;

interface KeyState<T> {
  inFlight: boolean;
  /** Nächste wartende Payload (ersetzt ältere wartende — Koaleszenz) */
  pending?: { payload: T };
  /** Letzte fehlgeschlagene Payload (für Retry) */
  failed?: { payload: T; error: string };
}

export class ScheduleSaveQueue<T> {
  private saveFn: SaveFn<T>;
  private keys = new Map<string, KeyState<T>>();
  private listeners = new Set<(snap: SaveQueueSnapshot) => void>();
  private lastSavedAt: Date | null = null;
  private now: () => Date;

  constructor(saveFn: SaveFn<T>, opts?: { now?: () => Date }) {
    this.saveFn = saveFn;
    this.now = opts?.now ?? (() => new Date());
  }

  /** Payload für einen Schlüssel einreihen (ersetzt wartende Payload). */
  enqueue(key: string, payload: T): void {
    let state = this.keys.get(key);
    if (!state) {
      state = { inFlight: false };
      this.keys.set(key, state);
    }
    // Neuer Schreibversuch löscht den Fehlerzustand des Schlüssels
    state.failed = undefined;

    if (state.inFlight) {
      // Koaleszenz: nur die NEUESTE wartende Payload behalten
      state.pending = { payload };
    } else {
      state.pending = { payload };
      void this.startNext(key);
    }
    this.emit();
  }

  /** Fehlgeschlagene Saves erneut versuchen. */
  retryFailed(): void {
    for (const [key, state] of this.keys) {
      if (state.failed && !state.inFlight && !state.pending) {
        const { payload } = state.failed;
        state.failed = undefined;
        state.pending = { payload };
        void this.startNext(key);
      }
    }
    this.emit();
  }

  /** true wenn irgendein Save läuft oder wartet. */
  hasPending(): boolean {
    for (const state of this.keys.values()) {
      if (state.inFlight || state.pending) return true;
    }
    return false;
  }

  /** true wenn mindestens ein Save fehlgeschlagen ist (und nicht neu eingereiht). */
  hasErrors(): boolean {
    for (const state of this.keys.values()) {
      if (state.failed) return true;
    }
    return false;
  }

  getSnapshot(): SaveQueueSnapshot {
    let pendingCount = 0;
    let errorCount = 0;
    const errors: Record<string, string> = {};
    for (const [key, state] of this.keys) {
      if (state.inFlight || state.pending) pendingCount++;
      if (state.failed) {
        errorCount++;
        errors[key] = state.failed.error;
      }
    }
    return {
      pendingCount,
      errorCount,
      errors,
      lastSavedAt: this.lastSavedAt,
      isSaving: pendingCount > 0,
    };
  }

  subscribe(listener: (snap: SaveQueueSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Wartet bis alle laufenden/wartenden Saves abgeschlossen sind. */
  async flush(timeoutMs = 15000): Promise<boolean> {
    const start = Date.now();
    while (this.hasPending()) {
      if (Date.now() - start > timeoutMs) return false;
      await new Promise(r => setTimeout(r, 50));
    }
    return true;
  }

  /** Alles verwerfen (z. B. bei Tenant-Wechsel nach User-Bestätigung). */
  clear(): void {
    this.keys.clear();
    this.emit();
  }

  private async startNext(key: string): Promise<void> {
    const state = this.keys.get(key);
    if (!state || state.inFlight || !state.pending) return;

    const { payload } = state.pending;
    state.pending = undefined;
    state.inFlight = true;
    this.emit();

    try {
      await this.saveFn(key, payload);
      state.inFlight = false;
      // Nur „gespeichert" wenn nichts Neues wartet und kein Fehler
      if (!state.pending) {
        this.lastSavedAt = this.now();
        if (!state.failed) this.keys.delete(key);
      }
    } catch (err) {
      state.inFlight = false;
      // Fehler nur festhalten, wenn keine neuere Payload wartet
      // (die neuere ersetzt den fehlgeschlagenen Stand ohnehin)
      if (!state.pending) {
        state.failed = { payload, error: err instanceof Error ? err.message : String(err) };
      }
    }

    // Wartende Payload (während des Saves eingetroffen) starten
    if (state.pending) {
      this.emit();
      await this.startNext(key);
      return;
    }
    this.emit();
  }

  private emit(): void {
    const snap = this.getSnapshot();
    for (const listener of this.listeners) listener(snap);
  }
}

/** Schlüssel-Helfer: stabile Identität einer Zelle je Namensraum. */
export function planSaveKey(employeeId: string, date: string): string {
  return `plan:${employeeId}|${date}`;
}
export function istSaveKey(employeeId: string, date: string): string {
  return `ist:${employeeId}|${date}`;
}
export function parseSaveKey(key: string): { ns: string; employeeId: string; date: string } | null {
  const m = key.match(/^(plan|ist|kv):(.+)\|(\d{4}-\d{2}-\d{2}|[\w-]+)$/);
  if (!m) return null;
  return { ns: m[1], employeeId: m[2], date: m[3] };
}
