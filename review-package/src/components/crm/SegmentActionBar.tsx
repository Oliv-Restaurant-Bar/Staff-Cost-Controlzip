/**
 * SegmentActionBar — interne CRM-Aktionen für ein Smart-Segment / eine Auswahl
 * ===========================================================================
 * Bündelt fünf INTERNE, manuell ausgelöste Aktionen (keine E-Mails/WhatsApp,
 * keine externen Integrationen) über die aktuell ausgewählten Gäste — oder, wenn
 * nichts angehakt ist, über das ganze gefilterte Smart-Segment:
 *
 *   1) CSV exportieren        (Logik liegt in der Seite → `onExportCsv`)
 *   2) Kontaktliste erstellen (guest_crm_contact_lists)
 *   3) Als kontaktiert markieren
 *   4) Notiz hinzufügen
 *   5) Folgeaufgabe erstellen
 *
 * Jede schreibende Aktion ist bestätigungsbasiert (Dialog) und zeigt die Anzahl
 * betroffener Gäste. Die Datenbankschicht (`crm-activities-db.ts`) prüft vor dem
 * Schreiben, dass alle Gäste zum Mandanten gehören (verifyGuestsBelongToTenant).
 */

import { useState } from 'react';
import {
  FileDown, ListPlus, CheckCircle2, StickyNote, CalendarClock, Loader2, Users,
} from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import {
  markGuestsContacted, addGuestNote, createFollowUpTask, createContactList,
} from '@/lib/crm-activities-db';

type ActionKind = 'list' | 'contacted' | 'note' | 'follow_up';

interface SegmentActionBarProps {
  tenantId: string;
  /** Gäste, auf die sich die Aktionen beziehen (Auswahl oder ganzes Segment). */
  targetIds: string[];
  /** true, wenn explizit Gäste angehakt sind (sonst: ganzes Segment). */
  hasSelection: boolean;
  segmentKey: string;
  segmentLabel: string;
  /** Heutiges Datum (yyyy-MM-dd) für „als kontaktiert markiert". */
  today: string;
  /** false, wenn die CRM-Aktionstabellen (noch) nicht existieren → Schreibaktionen deaktiviert. */
  actionsAvailable: boolean;
  onExportCsv: () => void;
  /** Nach erfolgreicher Aktion: Auswahl leeren / ggf. neu laden. */
  onDone: () => void;
}

export function SegmentActionBar({
  tenantId, targetIds, hasSelection, segmentKey, segmentLabel, today, actionsAvailable,
  onExportCsv, onDone,
}: SegmentActionBarProps) {
  const { toast } = useToast();
  const [action, setAction] = useState<ActionKind | null>(null);
  const [busy, setBusy] = useState(false);

  // Formularfelder der Dialoge.
  const [listName, setListName] = useState('');
  const [contactNote, setContactNote] = useState('');
  const [noteText, setNoteText] = useState('');
  const [dueDate, setDueDate] = useState(today);
  const [followUpDesc, setFollowUpDesc] = useState('');

  const count = targetIds.length;
  const scopeLabel = hasSelection
    ? `${count} ausgewählte${count === 1 ? 'r Gast' : ' Gäste'}`
    : `alle ${count} Gäste im Segment`;

  function openAction(kind: ActionKind) {
    // Felder beim Öffnen zurücksetzen (Folgeaufgabe: Fälligkeit = heute).
    setListName(segmentLabel);
    setContactNote('');
    setNoteText('');
    setDueDate(today);
    setFollowUpDesc('');
    setAction(kind);
  }

  function closeAction() {
    if (busy) return;
    setAction(null);
  }

  async function run(fn: () => Promise<number | void>, successTitle: (n: number) => string) {
    setBusy(true);
    try {
      const n = await fn();
      toast({ title: successTitle(typeof n === 'number' ? n : count) });
      setAction(null);
      onDone();
    } catch (e) {
      toast({
        title: 'Aktion fehlgeschlagen',
        description: e instanceof Error ? e.message : 'Unbekannter Fehler',
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  }

  const noteEmpty = noteText.trim() === '';
  const listNameEmpty = listName.trim() === '';
  const dueEmpty = dueDate.trim() === '';
  // CSV-Export ist rein clientseitig und immer möglich; die übrigen Aktionen
  // schreiben in `guest_crm_activities`/`guest_crm_contact_lists` und werden
  // deaktiviert, solange diese Tabellen (noch) nicht existieren.
  const writeDisabled = count === 0 || !actionsAvailable;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 p-2.5">
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
        <Users className="h-3.5 w-3.5 text-primary" />
        Aktionen für {scopeLabel}
      </span>

      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        <ActionButton icon={FileDown} label="CSV" onClick={onExportCsv} disabled={count === 0} />
        <ActionButton icon={ListPlus} label="Kontaktliste" onClick={() => openAction('list')} disabled={writeDisabled} />
        <ActionButton icon={CheckCircle2} label="Kontaktiert" onClick={() => openAction('contacted')} disabled={writeDisabled} />
        <ActionButton icon={StickyNote} label="Notiz" onClick={() => openAction('note')} disabled={writeDisabled} />
        <ActionButton icon={CalendarClock} label="Folgeaufgabe" onClick={() => openAction('follow_up')} disabled={writeDisabled} />
      </div>

      {!actionsAvailable && (
        <p className="w-full text-[11px] text-amber-700 dark:text-amber-300">
          CRM-Aktionen sind noch nicht verfügbar — bitte die Migration
          <span className="font-mono"> 20260624_crm_activities.sql </span>
          im SQL-Editor ausführen. CSV-Export funktioniert trotzdem.
        </p>
      )}

      {/* Kontaktliste erstellen */}
      <Dialog open={action === 'list'} onOpenChange={(v) => !v && closeAction()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Kontaktliste erstellen</DialogTitle>
            <DialogDescription>
              Speichert {scopeLabel} als benannte Kontaktliste (intern, kein Versand).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>Name der Liste</Label>
            <Input
              value={listName}
              onChange={(e) => setListName(e.target.value)}
              placeholder="z. B. VIP-Reaktivierung Juni"
              disabled={busy}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeAction} disabled={busy}>Abbrechen</Button>
            <Button
              onClick={() => run(
                () => createContactList(tenantId, listName, targetIds, { segmentKey }),
                () => `Kontaktliste „${listName.trim()}" mit ${count} Gästen erstellt.`,
              )}
              disabled={busy || listNameEmpty || count === 0}
            >
              {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <ListPlus className="mr-1.5 h-4 w-4" />}
              Erstellen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Als kontaktiert markieren */}
      <Dialog open={action === 'contacted'} onOpenChange={(v) => !v && closeAction()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Als kontaktiert markieren</DialogTitle>
            <DialogDescription>
              Markiert {scopeLabel} mit dem heutigen Datum als kontaktiert.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>Notiz (optional)</Label>
            <Textarea
              value={contactNote}
              onChange={(e) => setContactNote(e.target.value)}
              placeholder="z. B. Telefonisch erreicht, Tisch reserviert"
              rows={3}
              disabled={busy}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeAction} disabled={busy}>Abbrechen</Button>
            <Button
              onClick={() => run(
                () => markGuestsContacted(tenantId, targetIds, { segmentKey, note: contactNote, contactedOn: today }),
                (n) => `${n} Gast/Gäste als kontaktiert markiert.`,
              )}
              disabled={busy || count === 0}
            >
              {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-1.5 h-4 w-4" />}
              Markieren
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Notiz hinzufügen */}
      <Dialog open={action === 'note'} onOpenChange={(v) => !v && closeAction()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Notiz hinzufügen</DialogTitle>
            <DialogDescription>
              Fügt {scopeLabel} dieselbe interne Notiz hinzu.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>Notiz</Label>
            <Textarea
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="Interne Notiz…"
              rows={4}
              disabled={busy}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeAction} disabled={busy}>Abbrechen</Button>
            <Button
              onClick={() => run(
                () => addGuestNote(tenantId, targetIds, noteText, { segmentKey }),
                (n) => `Notiz zu ${n} Gast/Gästen hinzugefügt.`,
              )}
              disabled={busy || noteEmpty || count === 0}
            >
              {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <StickyNote className="mr-1.5 h-4 w-4" />}
              Hinzufügen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Folgeaufgabe erstellen */}
      <Dialog open={action === 'follow_up'} onOpenChange={(v) => !v && closeAction()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Folgeaufgabe erstellen</DialogTitle>
            <DialogDescription>
              Legt {scopeLabel} eine interne Folgeaufgabe mit Fälligkeitsdatum an.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Fällig am</Label>
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} disabled={busy} />
            </div>
            <div className="space-y-1.5">
              <Label>Beschreibung (optional)</Label>
              <Textarea
                value={followUpDesc}
                onChange={(e) => setFollowUpDesc(e.target.value)}
                placeholder="z. B. Erneut anrufen, Sonderangebot vorstellen"
                rows={3}
                disabled={busy}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeAction} disabled={busy}>Abbrechen</Button>
            <Button
              onClick={() => run(
                () => createFollowUpTask(tenantId, targetIds, dueDate, { description: followUpDesc, segmentKey }),
                (n) => `Folgeaufgabe für ${n} Gast/Gäste erstellt.`,
              )}
              disabled={busy || dueEmpty || count === 0}
            >
              {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <CalendarClock className="mr-1.5 h-4 w-4" />}
              Erstellen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ActionButton({ icon: Icon, label, onClick, disabled }: {
  icon: React.FC<{ className?: string }>;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}
