/**
 * «Offene Punkte» im Dienstplan — Vorschläge aus der Bedarf-vs-Plan-Analyse
 * =========================================================================
 * Badge-Button mit Zähler + Dialog-Liste aller offenen Vorschläge des
 * Mandanten. Pro Punkt: BESTÄTIGEN (bei «einplanen»: konkrete Schichtzeit
 * setzen, bei «offener Platz» zusätzlich Person wählen; bei «streichen»:
 * Entfernen bestätigen) oder ABLEHNEN. Erst die Bestätigung erzeugt/entfernt
 * den echten Dienstplan-Eintrag — über den tages-atomaren Schreibpfad des
 * Planners (Callbacks), nie direkt.
 *
 * Konfliktprüfung greift auch HIER erneut (Lage kann sich seit dem Vorschlag
 * geändert haben): bereits geplante Zeiten oder Absenz (FE/K/U) am Tag →
 * Warnung mit «Trotzdem bestätigen» / «Abbrechen». Warnung, keine Sperre.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';
import { toast } from 'sonner';
import { ClipboardList, Loader2, AlertTriangle, Check, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

import type { Employee, DaySchedule } from '@/types/personnel';
import { employeeCanCover } from '@/lib/position-utils';
import {
  fetchOpenProposals, setProposalStatus, fillProposalEmployee,
  type SchedulePlanProposal,
} from '@/lib/schedule-proposal-store';

interface ConfirmDraft {
  proposal: SchedulePlanProposal;
  /** Nur bei «offener Platz» wählbar; sonst fix aus dem Vorschlag. */
  employeeId: string;
  start: string;
  end: string;
  /** Aktive Konfliktwarnung, die per «Trotzdem bestätigen» quittiert werden muss. */
  conflict: string | null;
  conflictAccepted: boolean;
}

export function ScheduleProposalInbox({
  tenantId, employees, scheduleData, readOnly,
  onConfirmAdd, onConfirmRemove,
}: {
  tenantId: string;
  employees: Employee[];
  /** Aktueller Planstand `${employeeId}-${date}` (für die erneute Konfliktprüfung). */
  scheduleData: Record<string, DaySchedule>;
  readOnly?: boolean;
  /**
   * Erzeugt den echten Plan-Eintrag über den tages-atomaren Schreibpfad.
   * Rückgabe false = fehlgeschlagen (z.B. beide Slots belegt) → Punkt bleibt offen.
   */
  onConfirmAdd: (employeeId: string, date: string, slot: { start: string; end: string }) => boolean;
  /** Entfernt den GANZEN Tageseintrag der Person (tages-atomar). */
  onConfirmRemove: (employeeId: string, date: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [proposals, setProposals] = useState<SchedulePlanProposal[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ConfirmDraft | null>(null);
  /** Entfernen-Bestätigung: Vorschlags-id + ob eine Abweichungs-Warnung quittiert wurde. */
  const [removeDraft, setRemoveDraft] = useState<{ id: string; accepted: boolean } | null>(null);

  const reload = useCallback(() => {
    fetchOpenProposals(tenantId)
      .then((list) => {
        setProposals(list.sort((a, b) => a.date.localeCompare(b.date) || a.positionName.localeCompare(b.positionName)));
        setLoadError(null);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, [tenantId]);

  useEffect(() => { reload(); }, [reload, open]);

  const nameById = useMemo(() => new Map(employees.map((e) => [e.id, e.name])), [employees]);

  /** Erneute Konfliktprüfung gegen den AKTUELLEN Planstand. */
  const conflictNow = useCallback((employeeId: string, date: string): string | null => {
    const entry = scheduleData[`${employeeId}-${date}`];
    if (!entry) return null;
    const name = nameById.get(employeeId) ?? employeeId;
    const dayLabel = format(parseISO(date), 'EEEE dd.MM.', { locale: de });
    const absence = entry.frühAbsence || entry.spätAbsence;
    if (absence) return `${name} ist am ${dayLabel} als ${absence} eingetragen.`;
    const times = [entry.früh, entry.spät].filter(Boolean).map((s) => `${s!.start}–${s!.end}`);
    if (times.length > 0) return `${name} ist am ${dayLabel} bereits geplant: ${times.join(', ')}.`;
    return null;
  }, [scheduleData, nameById]);

  const startConfirm = (p: SchedulePlanProposal) => {
    const employeeId = p.employeeId ?? '';
    setDraft({
      proposal: p,
      employeeId,
      start: '11:00',
      end: '14:00',
      conflict: employeeId ? conflictNow(employeeId, p.date) : null,
      conflictAccepted: false,
    });
  };

  const finishConfirmAdd = async () => {
    if (!draft) return;
    const { proposal } = draft;
    if (!draft.employeeId) { toast.error('Bitte zuerst eine Person wählen.'); return; }
    if (!/^\d{2}:\d{2}$/.test(draft.start) || !/^\d{2}:\d{2}$/.test(draft.end) || draft.start >= draft.end) {
      toast.error('Bitte gültige Schichtzeit angeben (Von < Bis).');
      return;
    }
    const conflict = conflictNow(draft.employeeId, proposal.date);
    if (conflict && !draft.conflictAccepted) {
      setDraft({ ...draft, conflict });
      return;
    }
    setBusyId(proposal.id);
    try {
      const ok = onConfirmAdd(draft.employeeId, proposal.date, { start: draft.start, end: draft.end });
      if (!ok) return; // Fehlermeldung kommt aus dem Planner; Punkt bleibt offen.
      if (proposal.employeeId == null) {
        const emp = employees.find((e) => e.id === draft.employeeId);
        await fillProposalEmployee(tenantId, proposal.id, draft.employeeId, emp?.name ?? draft.employeeId);
      }
      await setProposalStatus(tenantId, proposal.id, 'confirmed',
        `Bestätigt: ${draft.start}–${draft.end}${conflict ? ' (Konflikt bewusst bestätigt)' : ''}`);
      toast.success(`${nameById.get(draft.employeeId) ?? draft.employeeId} am ${format(parseISO(proposal.date), 'dd.MM.', { locale: de })} eingeplant (${draft.start}–${draft.end}).`);
      setDraft(null);
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Bestätigung fehlgeschlagen');
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Aktueller Tages-Zustand fürs Entfernen — wird UNMITTELBAR vor der Mutation
   * erneut geprüft (Vorschlag kann veraltet sein: neue Schicht oder Absenz seit
   * dem Vormerken). Absenz oder Split-Tag ⇒ Warnung, die explizit per
   * «Trotzdem entfernen» quittiert werden muss.
   */
  const removeDayInfo = useCallback((p: SchedulePlanProposal): { empty: boolean; text: string; warn: boolean } => {
    const entry = p.employeeId ? scheduleData[`${p.employeeId}-${p.date}`] : undefined;
    if (!entry || (!entry.früh && !entry.spät && !entry.frühAbsence && !entry.spätAbsence)) {
      return { empty: true, text: 'An diesem Tag ist kein Eintrag (mehr) vorhanden — es gibt nichts zu entfernen.', warn: false };
    }
    const parts: string[] = [];
    if (entry.früh) parts.push(`Früh ${entry.früh.start}–${entry.früh.end}`);
    if (entry.spät) parts.push(`Spät ${entry.spät.start}–${entry.spät.end}`);
    if (entry.frühAbsence) parts.push(`Absenz ${entry.frühAbsence}`);
    if (entry.spätAbsence) parts.push(`Absenz ${entry.spätAbsence}`);
    const hasAbsence = !!(entry.frühAbsence || entry.spätAbsence);
    const slotCount = (entry.früh ? 1 : 0) + (entry.spät ? 1 : 0);
    return {
      empty: false,
      text: `Aktueller Eintrag: ${parts.join(' · ')}. Der GANZE Tageseintrag wird entfernt.`,
      // Warnpflicht: Absenz würde gelöscht ODER der Tag hat mehr als eine
      // Schicht (Split) — beides kann NACH dem Vormerken entstanden sein.
      warn: hasAbsence || slotCount > 1,
    };
  }, [scheduleData]);

  const finishConfirmRemove = async (p: SchedulePlanProposal) => {
    if (!p.employeeId) return;
    // Re-Check gegen den AKTUELLEN Stand — nie den Stand vom Vormerken.
    const info = removeDayInfo(p);
    if (info.warn && !removeDraft?.accepted) return; // UI erzwingt «Trotzdem entfernen»
    setBusyId(p.id);
    try {
      if (!info.empty) onConfirmRemove(p.employeeId, p.date);
      await setProposalStatus(tenantId, p.id, 'confirmed',
        info.empty ? 'Eintrag war bereits leer' : `Entfernen bestätigt (${info.text})`);
      toast.success(info.empty
        ? 'Punkt geschlossen — der Eintrag war bereits leer.'
        : `${p.employeeName} am ${format(parseISO(p.date), 'dd.MM.', { locale: de })} aus dem Plan entfernt.`);
      setRemoveDraft(null);
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Bestätigung fehlgeschlagen');
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (p: SchedulePlanProposal) => {
    setBusyId(p.id);
    try {
      await setProposalStatus(tenantId, p.id, 'rejected');
      toast.info('Vorschlag verworfen.');
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Verwerfen fehlgeschlagen');
    } finally {
      setBusyId(null);
    }
  };

  if (proposals.length === 0 && !open && !loadError) return null;

  return (
    <>
      <Button
        type="button" variant="outline" size="sm" className="h-8 gap-1.5 text-xs"
        onClick={() => setOpen(true)}
        data-testid="button-open-proposals"
      >
        <ClipboardList className="h-3.5 w-3.5" />
        Offene Punkte
        {proposals.length > 0 && (
          <Badge className="ml-0.5 h-4 min-w-4 px-1 text-[10px] bg-sky-600 hover:bg-sky-600" data-testid="badge-open-proposals">
            {proposals.length}
          </Badge>
        )}
      </Button>

      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setDraft(null); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ClipboardList className="h-5 w-5" />
              Offene Punkte aus der Bedarf-Analyse
            </DialogTitle>
            <DialogDescription>
              Vorschläge aus dem Bedarf-vs-Plan-Detail. Erst die Bestätigung erstellt bzw.
              entfernt den echten Dienstplan-Eintrag — Ablehnen verwirft ohne Änderung.
            </DialogDescription>
          </DialogHeader>

          {loadError && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>Offene Punkte konnten nicht geladen werden: {loadError}</AlertDescription>
            </Alert>
          )}

          {!loadError && proposals.length === 0 && (
            <p className="text-sm text-muted-foreground py-2" data-testid="text-no-proposals">
              Keine offenen Punkte — alle Vorschläge sind bestätigt oder verworfen.
            </p>
          )}

          <div className="space-y-2">
            {proposals.map((p) => {
              const isDraft = draft?.proposal.id === p.id;
              const dayLabel = format(parseISO(p.date), 'EEEE dd.MM.yyyy', { locale: de });
              return (
                <div key={p.id} className="rounded-lg border p-2.5 space-y-2" data-testid={`proposal-item-${p.id}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-sm">
                      <span className={p.type === 'add' ? 'text-emerald-700 dark:text-emerald-400 font-medium' : 'text-red-700 dark:text-red-400 font-medium'}>
                        {p.type === 'add' ? '+ Einplanen' : '− Streichen'}
                      </span>
                      {': '}
                      <span className="font-medium">{p.employeeName ?? 'Offener Platz'}</span>
                      {' · '}{p.positionName}{' · '}{dayLabel}
                      {p.conflictNote && (
                        <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-0.5">
                          Beim Vormerken bewusst bestätigt: {p.conflictNote}
                        </p>
                      )}
                    </div>
                    {!isDraft && (
                      <div className="flex shrink-0 gap-1.5">
                        {!readOnly && (
                          p.type === 'add' ? (
                            <Button type="button" size="sm" className="h-7 gap-1 px-2 text-xs" disabled={busyId === p.id}
                              onClick={() => startConfirm(p)} data-testid={`button-confirm-${p.id}`}>
                              <Check className="h-3 w-3" /> Bestätigen…
                            </Button>
                          ) : (
                            <Button type="button" size="sm" variant="destructive" className="h-7 gap-1 px-2 text-xs" disabled={busyId === p.id}
                              onClick={() => setRemoveDraft({ id: p.id, accepted: false })} data-testid={`button-confirm-${p.id}`}
                              title="Zeigt den aktuellen Tageseintrag und fragt vor dem Entfernen nach.">
                              <Check className="h-3 w-3" /> Entfernen…
                            </Button>
                          )
                        )}
                        <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs text-muted-foreground" disabled={busyId === p.id}
                          onClick={() => void reject(p)} data-testid={`button-reject-${p.id}`}>
                          <X className="h-3 w-3" /> Ablehnen
                        </Button>
                      </div>
                    )}
                  </div>

                  {/* Bestätigungs-Formular «einplanen»: Person (falls offen) + Schichtzeit */}
                  {isDraft && draft && (
                    <div className="rounded-md bg-muted/40 p-2.5 space-y-2">
                      {p.employeeId == null && (
                        <div className="space-y-0.5">
                          <Label className="text-[10px] text-muted-foreground">Person (qualifiziert für {p.positionName})</Label>
                          <Select
                            value={draft.employeeId}
                            onValueChange={(v) => setDraft({ ...draft, employeeId: v, conflict: conflictNow(v, p.date), conflictAccepted: false })}
                          >
                            <SelectTrigger className="h-8 text-sm" data-testid="select-confirm-employee">
                              <SelectValue placeholder="Person wählen…" />
                            </SelectTrigger>
                            <SelectContent>
                              {employees
                                .filter((e) => e.isActive !== false && employeeCanCover(e, p.positionKey))
                                .map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                      <div className="flex items-end gap-2">
                        <div className="space-y-0.5">
                          <Label className="text-[10px] text-muted-foreground">Von</Label>
                          <Input type="time" className="h-8 w-[6.5rem] text-sm" value={draft.start}
                            onChange={(e) => setDraft({ ...draft, start: e.target.value })} data-testid="input-confirm-start" />
                        </div>
                        <div className="space-y-0.5">
                          <Label className="text-[10px] text-muted-foreground">Bis</Label>
                          <Input type="time" className="h-8 w-[6.5rem] text-sm" value={draft.end}
                            onChange={(e) => setDraft({ ...draft, end: e.target.value })} data-testid="input-confirm-end" />
                        </div>
                        <Button type="button" size="sm" className="h-8 px-2 text-xs" disabled={busyId === p.id || !draft.employeeId}
                          onClick={() => void finishConfirmAdd()} data-testid="button-confirm-write">
                          {busyId === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Eintrag erstellen'}
                        </Button>
                        <Button type="button" size="sm" variant="ghost" className="h-8 px-2 text-xs" onClick={() => setDraft(null)}>
                          Abbrechen
                        </Button>
                      </div>
                      {draft.conflict && !draft.conflictAccepted && (
                        <Alert className="border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30">
                          <AlertTriangle className="h-4 w-4 text-amber-700" />
                          <AlertDescription className="space-y-1.5">
                            <p className="text-xs" data-testid="text-confirm-conflict">{draft.conflict}</p>
                            <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs"
                              onClick={() => setDraft({ ...draft, conflictAccepted: true })} data-testid="button-confirm-conflict-anyway">
                              Trotzdem bestätigen
                            </Button>
                          </AlertDescription>
                        </Alert>
                      )}
                      {draft.conflict && draft.conflictAccepted && (
                        <p className="text-[11px] text-amber-700 dark:text-amber-400">
                          Konflikt bestätigt — «Eintrag erstellen» plant trotzdem ein (z.B. zweite Schicht/Split).
                        </p>
                      )}
                    </div>
                  )}

                  {/* Entfernen-Bestätigung: aktueller Tageszustand wird erneut
                      geprüft (Vorschlag kann veraltet sein) — Absenz/Split
                      erfordert explizites «Trotzdem entfernen». */}
                  {removeDraft?.id === p.id && p.type === 'remove' && (() => {
                    const info = removeDayInfo(p);
                    return (
                      <div className="rounded-md bg-muted/40 p-2.5 space-y-2" data-testid={`remove-confirm-${p.id}`}>
                        <p className="text-xs" data-testid="text-remove-current-state">{info.text}</p>
                        {info.warn && !removeDraft.accepted ? (
                          <Alert className="border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30">
                            <AlertTriangle className="h-4 w-4 text-amber-700" />
                            <AlertDescription className="space-y-1.5">
                              <p className="text-xs" data-testid="text-remove-warning">
                                Der Tag hat sich seit dem Vormerken möglicherweise geändert
                                (Absenz bzw. mehrere Schichten). Wirklich den GANZEN Tageseintrag entfernen?
                              </p>
                              <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs"
                                onClick={() => setRemoveDraft({ id: p.id, accepted: true })} data-testid="button-remove-anyway">
                                Trotzdem entfernen
                              </Button>
                            </AlertDescription>
                          </Alert>
                        ) : (
                          <Button type="button" size="sm" variant={info.empty ? 'outline' : 'destructive'} className="h-7 gap-1 px-2 text-xs"
                            disabled={busyId === p.id}
                            onClick={() => void finishConfirmRemove(p)} data-testid="button-remove-write">
                            {busyId === p.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                            {info.empty ? 'Punkt schliessen' : 'Entfernen bestätigen'}
                          </Button>
                        )}
                        <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs ml-1.5"
                          onClick={() => setRemoveDraft(null)}>
                          Abbrechen
                        </Button>
                      </div>
                    );
                  })()}
                </div>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
