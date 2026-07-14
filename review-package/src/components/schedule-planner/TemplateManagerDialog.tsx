import { useState, useEffect, useMemo } from 'react';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  BookOpen, Save, Trash2, Play, ChevronDown, ChevronRight,
  LayoutTemplate, CalendarDays, Info, Check,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Employee } from '@/types/personnel';
import { DaySchedule } from './ScheduleGrid';
import {
  WeekTemplate,
  TemplateDept,
  DemandBand,
  ApplyMode,
  ApplyOptions,
  loadTemplates,
  saveTemplate,
  deleteTemplate,
  captureWeek,
  applyTemplate,
  WEEKDAY_LABELS,
  WEEKDAY_LABELS_LONG,
  DEMAND_BAND_LABELS,
  DEMAND_BAND_COLORS,
} from '@/lib/schedule-templates';

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onClose: () => void;
  employees: Employee[];
  scheduleData: Record<string, DaySchedule>;
  displayDays: Date[];
  activeDepartment: TemplateDept;
  onApply: (delta: Record<string, DaySchedule>) => void;
}

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

function deptLabel(d: TemplateDept): string {
  return d === 'all' ? 'Alle' : d === 'service' ? 'Service' : 'Küche';
}
function deptClass(d: TemplateDept): string {
  return d === 'all'
    ? 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800/40 dark:text-slate-300'
    : d === 'service'
      ? 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300'
      : 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300';
}

function Toggle<T extends string>({
  value, options, onChange, labelMap, colorMap, size = 'sm',
}: {
  value: T;
  options: T[];
  onChange: (v: T) => void;
  labelMap: Record<string, string>;
  colorMap?: Record<string, string>;
  size?: 'sm' | 'xs';
}) {
  return (
    <div className="flex gap-1">
      {options.map(o => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className={cn(
            'px-2 rounded border font-medium transition-colors',
            size === 'xs' ? 'py-0.5 text-[10px]' : 'py-1 text-xs',
            value === o
              ? colorMap?.[o] ?? 'bg-primary text-primary-foreground border-primary'
              : 'bg-muted/50 text-muted-foreground border-border hover:bg-muted',
          )}
        >
          {labelMap[o]}
        </button>
      ))}
    </div>
  );
}

// ─── Vorlage speichern ────────────────────────────────────────────────────────

function SaveSection({
  employees, scheduleData, displayDays, activeDepartment, onSaved,
}: {
  employees: Employee[];
  scheduleData: Record<string, DaySchedule>;
  displayDays: Date[];
  activeDepartment: TemplateDept;
  onSaved: () => void;
}) {
  const [name, setName]       = useState('');
  const [dept, setDept]       = useState<TemplateDept>(activeDepartment);
  const [band, setBand]       = useState<DemandBand>('normal');
  const [notes, setNotes]     = useState('');
  const [saved, setSaved]     = useState(false);

  const periodLabel = useMemo(() => {
    if (!displayDays.length) return '';
    return `${format(displayDays[0], 'd.M.')} – ${format(displayDays[displayDays.length - 1], 'd.M.yyyy', { locale: de })}`;
  }, [displayDays]);

  // Count entries that would be captured
  const entryCount = useMemo(() => {
    let n = 0;
    for (const emp of employees) {
      if (dept !== 'all' && emp.department !== dept) continue;
      for (const day of displayDays) {
        const ds = scheduleData[`${emp.id}-${format(day, 'yyyy-MM-dd')}`];
        if (ds && (ds.früh?.start || ds.frühAbsence || ds.spät?.start || ds.spätAbsence)) n++;
      }
    }
    return n;
  }, [employees, scheduleData, displayDays, dept]);

  const handleSave = () => {
    const tname = name.trim() || `Woche ${periodLabel}`;
    const tpl   = captureWeek(employees, displayDays, scheduleData, tname, dept, band, notes.trim() || undefined);
    saveTemplate(tpl);
    setSaved(true);
    setTimeout(() => { setSaved(false); setName(''); setNotes(''); onSaved(); }, 1200);
  };

  return (
    <div className="rounded-lg border bg-muted/20 p-3 space-y-3">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
        <Save className="h-3.5 w-3.5" />
        Aktuelle Woche speichern
      </p>

      <div className="flex items-center gap-2">
        <Input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder={`Woche ${periodLabel}`}
          className="h-7 text-sm flex-1"
        />
        <Button
          size="sm"
          className="h-7 gap-1.5 shrink-0"
          onClick={handleSave}
          disabled={entryCount === 0 || saved}
        >
          {saved ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
          {saved ? 'Gespeichert' : `Speichern (${entryCount})`}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="space-y-0.5">
          <p className="text-[10px] text-muted-foreground">Abteilung</p>
          <Toggle
            value={dept}
            options={['all', 'service', 'küche'] as TemplateDept[]}
            onChange={setDept}
            labelMap={{ all: 'Alle', service: 'Service', küche: 'Küche' }}
            size="xs"
          />
        </div>
        <div className="space-y-0.5">
          <p className="text-[10px] text-muted-foreground">Auslastung</p>
          <Toggle
            value={band}
            options={['low', 'normal', 'high'] as DemandBand[]}
            onChange={setBand}
            labelMap={{ low: 'Ruhig', normal: 'Normal', high: 'Voll' }}
            colorMap={Object.fromEntries(Object.entries(DEMAND_BAND_COLORS))}
            size="xs"
          />
        </div>
      </div>

      <Input
        value={notes}
        onChange={e => setNotes(e.target.value)}
        placeholder="Notizen (optional, z.B. Sommerplan, Event, ...)"
        className="h-7 text-xs"
      />

      {entryCount === 0 && (
        <p className="text-[10px] text-muted-foreground flex items-center gap-1">
          <Info className="h-3 w-3" />
          Keine Einträge in dieser Woche für die gewählte Abteilung
        </p>
      )}
    </div>
  );
}

// ─── Vorlage-Karte ────────────────────────────────────────────────────────────

function TemplateCard({
  tpl,
  employees,
  displayDays,
  existing,
  onApply,
  onDelete,
}: {
  tpl:       WeekTemplate;
  employees: Employee[];
  displayDays: Date[];
  existing:  Record<string, DaySchedule>;
  onApply:   (delta: Record<string, DaySchedule>) => void;
  onDelete:  () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [dept, setDept]         = useState<TemplateDept>(tpl.department === 'all' ? 'all' : tpl.department);
  const [mode, setMode]         = useState<ApplyMode>('merge');
  const [applied, setApplied]   = useState(false);

  const handleApply = () => {
    const opts: ApplyOptions = { department: dept, mode };
    const delta = applyTemplate(tpl, displayDays, employees, existing, opts);
    onApply(delta);
    setApplied(true);
    setTimeout(() => setApplied(false), 2000);
  };

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          onClick={() => setExpanded(v => !v)}
          className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>

        <div className="flex-1 min-w-0 flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-semibold truncate">{tpl.name}</span>
          <Badge variant="outline" className={cn('text-[10px] border', deptClass(tpl.department))}>
            {deptLabel(tpl.department)}
          </Badge>
          {tpl.demandBand && (
            <Badge variant="outline" className={cn('text-[10px] border', DEMAND_BAND_COLORS[tpl.demandBand])}>
              {DEMAND_BAND_LABELS[tpl.demandBand]}
            </Badge>
          )}
          <span className="text-[10px] text-muted-foreground ml-auto">
            {tpl.entryCount} Einträge · {format(new Date(tpl.createdAt), 'd.M.yy')}
          </span>
        </div>

        <button
          onClick={onDelete}
          className="shrink-0 p-1 text-muted-foreground hover:text-red-500 transition-colors"
          title="Vorlage löschen"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Notes */}
      {tpl.notes && !expanded && (
        <p className="px-8 pb-2 text-[10px] text-muted-foreground italic">{tpl.notes}</p>
      )}

      {/* Expanded apply options */}
      {expanded && (
        <div className="border-t bg-muted/20 px-3 py-2.5 space-y-2.5">
          {tpl.notes && (
            <p className="text-[10px] text-muted-foreground italic">{tpl.notes}</p>
          )}

          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-0.5">
              <p className="text-[10px] text-muted-foreground">Abteilung</p>
              <Toggle
                value={dept}
                options={
                  tpl.department === 'all'
                    ? ['all', 'service', 'küche'] as TemplateDept[]
                    : [tpl.department] as TemplateDept[]
                }
                onChange={setDept}
                labelMap={{ all: 'Alle', service: 'Service', küche: 'Küche' }}
                size="xs"
              />
            </div>
            <div className="space-y-0.5">
              <p className="text-[10px] text-muted-foreground">Modus</p>
              <Toggle
                value={mode}
                options={['merge', 'overwrite'] as ApplyMode[]}
                onChange={setMode}
                labelMap={{ merge: 'Zusammenführen', overwrite: 'Überschreiben' }}
                size="xs"
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="h-7 gap-1.5"
              onClick={handleApply}
              disabled={applied}
            >
              {applied ? <Check className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {applied ? 'Angewendet' : 'Auf aktuelle Woche anwenden'}
            </Button>
            <p className="text-[10px] text-muted-foreground">
              {mode === 'merge'
                ? 'Leere Slots werden befüllt, bestehende bleiben'
                : 'Alle passenden Slots werden ersetzt'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Wochentag-Muster ─────────────────────────────────────────────────────────

function WeekdayPatternTab({
  templates,
  employees,
  displayDays,
  existing,
  onApply,
}: {
  templates: WeekTemplate[];
  employees: Employee[];
  displayDays: Date[];
  existing: Record<string, DaySchedule>;
  onApply: (delta: Record<string, DaySchedule>) => void;
}) {
  const [selectedDay, setSelectedDay]  = useState<number>(1); // Mon
  const [selectedTpl, setSelectedTpl]  = useState<string>('');
  const [mode, setMode]                = useState<ApplyMode>('merge');
  const [dept, setDept]                = useState<TemplateDept>('all');
  const [applied, setApplied]          = useState(false);

  // The weekday buttons for the displayed days
  const displayedWeekdays = displayDays.map(d => d.getDay());

  const handleApply = () => {
    const tpl = templates.find(t => t.id === selectedTpl);
    if (!tpl) return;
    const opts: ApplyOptions = { department: dept, mode, onlyDayOfWeek: selectedDay };
    const delta = applyTemplate(tpl, displayDays, employees, existing, opts);
    onApply(delta);
    setApplied(true);
    setTimeout(() => setApplied(false), 2000);
  };

  if (templates.length === 0) {
    return (
      <div className="text-center py-10 space-y-2">
        <BookOpen className="h-8 w-8 text-muted-foreground mx-auto opacity-50" />
        <p className="text-sm text-muted-foreground">
          Noch keine Vorlagen vorhanden. Speichere zuerst eine Woche als Vorlage.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-muted/20 p-3 space-y-1.5">
        <p className="text-xs text-muted-foreground leading-relaxed">
          Wende eine Vorlage auf einen einzelnen Wochentag an — ideal für wiederkehrende
          Tagesbesetzungen wie „Montag Mittagsdienst" oder „Freitagabend Küche".
        </p>
      </div>

      <div className="space-y-3">
        {/* Weekday selector */}
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Wochentag</p>
          <div className="flex gap-1 flex-wrap">
            {[1, 2, 3, 4, 5, 6, 0].map(dow => (
              <button
                key={dow}
                onClick={() => setSelectedDay(dow)}
                disabled={!displayedWeekdays.includes(dow)}
                className={cn(
                  'px-2.5 py-1 rounded text-xs font-medium border transition-colors',
                  selectedDay === dow
                    ? 'bg-primary text-primary-foreground border-primary'
                    : displayedWeekdays.includes(dow)
                      ? 'bg-muted/50 text-muted-foreground border-border hover:bg-muted'
                      : 'opacity-30 bg-muted/20 text-muted-foreground border-border cursor-not-allowed',
                )}
              >
                {WEEKDAY_LABELS[dow]}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground">
            Inaktive Tage sind in der aktuellen Ansicht nicht sichtbar
          </p>
        </div>

        {/* Template selector */}
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Vorlage</p>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {templates.map(tpl => (
              <button
                key={tpl.id}
                onClick={() => setSelectedTpl(tpl.id)}
                className={cn(
                  'w-full text-left flex items-center gap-2 px-3 py-2 rounded border text-xs transition-colors',
                  selectedTpl === tpl.id
                    ? 'bg-primary/10 border-primary/50 text-foreground'
                    : 'bg-card border-border text-muted-foreground hover:bg-muted/40',
                )}
              >
                <LayoutTemplate className="h-3.5 w-3.5 shrink-0" />
                <span className="flex-1 font-medium">{tpl.name}</span>
                <Badge variant="outline" className={cn('text-[10px] border', deptClass(tpl.department))}>
                  {deptLabel(tpl.department)}
                </Badge>
                {tpl.demandBand && (
                  <Badge variant="outline" className={cn('text-[10px] border', DEMAND_BAND_COLORS[tpl.demandBand])}>
                    {DEMAND_BAND_LABELS[tpl.demandBand]}
                  </Badge>
                )}
                <span className="text-[10px] shrink-0">
                  {tpl.entries.filter(e => e.dayOfWeek === selectedDay).length} Eintr. {WEEKDAY_LABELS_LONG[selectedDay]}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Options */}
        <div className="flex flex-wrap gap-4">
          <div className="space-y-0.5">
            <p className="text-[10px] text-muted-foreground">Abteilung</p>
            <Toggle
              value={dept}
              options={['all', 'service', 'küche'] as TemplateDept[]}
              onChange={setDept}
              labelMap={{ all: 'Alle', service: 'Service', küche: 'Küche' }}
              size="xs"
            />
          </div>
          <div className="space-y-0.5">
            <p className="text-[10px] text-muted-foreground">Modus</p>
            <Toggle
              value={mode}
              options={['merge', 'overwrite'] as ApplyMode[]}
              onChange={setMode}
              labelMap={{ merge: 'Zusammenführen', overwrite: 'Überschreiben' }}
              size="xs"
            />
          </div>
        </div>

        {/* Apply */}
        <Button
          size="sm"
          className="gap-1.5"
          onClick={handleApply}
          disabled={!selectedTpl || applied}
        >
          {applied ? <Check className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          {applied
            ? 'Angewendet'
            : `${WEEKDAY_LABELS_LONG[selectedDay]} aus Vorlage befüllen`}
        </Button>
      </div>
    </div>
  );
}

// ─── Hauptdialog ──────────────────────────────────────────────────────────────

export function TemplateManagerDialog({
  open,
  onClose,
  employees,
  scheduleData,
  displayDays,
  activeDepartment,
  onApply,
}: Props) {
  const [tab, setTab]             = useState<'vorlagen' | 'muster'>('vorlagen');
  const [templates, setTemplates] = useState<WeekTemplate[]>([]);
  const [, forceRefresh]          = useState(0);

  // Load templates whenever dialog opens
  useEffect(() => {
    if (open) {
      setTemplates(loadTemplates());
      setTab('vorlagen');
    }
  }, [open]);

  const refresh = () => setTemplates(loadTemplates());

  const handleDelete = (id: string) => {
    deleteTemplate(id);
    refresh();
  };

  const handleApply = (delta: Record<string, DaySchedule>) => {
    onApply(delta);
    onClose();
  };

  const periodLabel = useMemo(() => {
    if (!displayDays.length) return '';
    return `${format(displayDays[0], 'd.M.')} – ${format(displayDays[displayDays.length - 1], 'd.M.yyyy', { locale: de })}`;
  }, [displayDays]);

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent
        className="max-w-2xl w-full"
        style={{ display: 'flex', flexDirection: 'column', maxHeight: '90vh' }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-emerald-500" />
            Wochenvorlagen
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {periodLabel && <span>Aktuelle Woche: {periodLabel} · </span>}
            Wochen speichern, laden und auf Einzeltage anwenden
          </DialogDescription>
        </DialogHeader>

        {/* Tabs */}
        <div className="flex gap-1 bg-muted/60 rounded-lg p-0.5 shrink-0">
          {([
            { id: 'vorlagen', label: 'Vorlagen', count: templates.length, icon: <BookOpen className="h-3.5 w-3.5" /> },
            { id: 'muster',   label: 'Wochentag-Muster', icon: <CalendarDays className="h-3.5 w-3.5" /> },
          ] as const).map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors',
                tab === t.id
                  ? 'bg-white dark:bg-slate-800 shadow-sm text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.icon}
              {t.label}
              {'count' in t && t.count > 0 && (
                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto flex-1 min-h-0 space-y-3 pr-0.5">

          {/* ── Vorlagen-Tab ─────────────────────────────────────────── */}
          {tab === 'vorlagen' && (
            <>
              <SaveSection
                employees={employees}
                scheduleData={scheduleData}
                displayDays={displayDays}
                activeDepartment={activeDepartment}
                onSaved={refresh}
              />

              {templates.length === 0 ? (
                <div className="text-center py-8 space-y-2">
                  <BookOpen className="h-8 w-8 text-muted-foreground mx-auto opacity-40" />
                  <p className="text-sm text-muted-foreground">
                    Noch keine Vorlagen gespeichert. Plane eine Woche und speichere sie oben.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-[10px] text-muted-foreground px-0.5 font-semibold uppercase tracking-wide">
                    {templates.length} gespeicherte Vorlage{templates.length !== 1 ? 'n' : ''}
                  </p>
                  {templates.map(tpl => (
                    <TemplateCard
                      key={tpl.id}
                      tpl={tpl}
                      employees={employees}
                      displayDays={displayDays}
                      existing={scheduleData}
                      onApply={handleApply}
                      onDelete={() => handleDelete(tpl.id)}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          {/* ── Wochentag-Muster-Tab ──────────────────────────────── */}
          {tab === 'muster' && (
            <WeekdayPatternTab
              templates={templates}
              employees={employees}
              displayDays={displayDays}
              existing={scheduleData}
              onApply={handleApply}
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pt-2 border-t border-border shrink-0">
          <p className="text-[10px] text-muted-foreground">
            Vorlagen lokal gespeichert · Anwenden immer auf die aktuell angezeigte Woche
          </p>
          <Button variant="ghost" size="sm" onClick={onClose}>Schliessen</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
