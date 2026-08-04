/**
 * Positionen — Verwaltung der Positions-/Stationsstammdaten (Personalbedarf-Grundlage).
 * ──────────────────────────────────────────────────────────────────────────────
 * Admin-Seite (Route /positionen, canAccessModule('positionen')). Positionen sind
 * je Abteilung (Service/Küche) konfigurierbar: Name, Farbe, Icon, Reihenfolge,
 * aktiv. Mitarbeitende referenzieren den stabilen `key` — daher ist der Key nach
 * dem Anlegen NICHT mehr änderbar (sonst verwaisen Zuordnungen).
 */
import { useMemo, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Plus, Pencil, Trash2, ArrowUp, ArrowDown, LayoutGrid, AlertTriangle, Sparkles,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import type { Department } from '@/types/personnel';
import type { Position } from '@/types/positions';
import { usePositions } from '@/hooks/usePositions';
import { usePermissions } from '@/hooks/usePermissions';
import {
  DEPARTMENTS, POSITION_COLORS, POSITION_ICONS,
  DEPT_DEFAULT_COLOR, DEPT_DEFAULT_ICON,
  slugifyKey, groupPositionsByArea, areasForDepartment,
} from '@/lib/position-utils';
import type { PositionAreaGroup } from '@/lib/position-utils';
import { DEPT_LABEL, DEPT_BADGE_CLASS } from '@/lib/station-config';
import { PositionIcon } from '@/components/PositionIcon';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PositionMatrix } from '@/components/positions/PositionMatrix';
import { useTenant } from '@/contexts/TenantContext';

/**
 * Kurzer, statischer Regel-Hinweis für Positionen mit dynamischer
 * Tagesbesetzung (CdS, Kalt/Sushi) — Details siehe Personalbedarf.
 */
export function staticDynamicRuleHint(positionKey: string): string | null {
  const k = positionKey.toLowerCase();
  if (k.includes('kalt') || k.includes('sushi')) {
    return 'Dynamische Regel (Kalte Küche/Sushi): Die konkrete Tagesbesetzung wird zusätzlich über die Stationsregel bestimmt; die Matrix zeigt die grundsätzlich Qualifizierten.';
  }
  if (k === 'service') {
    return 'Dynamische Regel (Chef de Service): Die konkrete Tagesbesetzung wird zusätzlich über die CdS-Prioritätsliste bestimmt; die Matrix zeigt die grundsätzlich Qualifizierten.';
  }
  return null;
}

interface DraftState {
  id?: string;
  key: string;
  name: string;
  department: Department;
  departmentGroup: string;
  color: string;
  icon: string;
  active: boolean;
  sortOrder: number;
}

function emptyDraft(dept: Department, sortOrder: number, departmentGroup: string): DraftState {
  return {
    key: '',
    name: '',
    department: dept,
    departmentGroup,
    color: DEPT_DEFAULT_COLOR[dept],
    icon: DEPT_DEFAULT_ICON[dept],
    active: true,
    sortOrder,
  };
}

export default function Positionen() {
  const { canAccessModule } = usePermissions();
  const { positions, loading, error, save, remove, seed, reload, applyDefaults } = usePositions();
  const { tenantId } = useTenant();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') === 'stammdaten' ? 'stammdaten' : 'matrix';

  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [busy, setBusy] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  const grouped = useMemo(() => {
    const map: Record<Department, PositionAreaGroup[]> = { service: [], 'küche': [] };
    for (const dept of DEPARTMENTS) {
      map[dept] = groupPositionsByArea(positions, dept, { includeInactive: showInactive });
    }
    return map;
  }, [positions, showInactive]);

  const positionToDraft = (p: Position): DraftState => ({
    id: p.id,
    key: p.key,
    name: p.name,
    department: p.department,
    departmentGroup: p.departmentGroup ?? '',
    color: p.color ?? DEPT_DEFAULT_COLOR[p.department],
    icon: p.icon ?? DEPT_DEFAULT_ICON[p.department],
    active: p.active,
    sortOrder: p.sortOrder,
  });

  const draftToSave = (d: DraftState) => ({
    id: d.id,
    key: d.key,
    name: d.name,
    department: d.department,
    departmentGroup: d.departmentGroup.trim() || undefined,
    color: d.color,
    icon: d.icon,
    sortOrder: d.sortOrder,
    active: d.active,
  });

  if (!canAccessModule('positionen')) {
    return <Navigate to="/personal" replace />;
  }

  const openNew = (dept: Department, areaKey: string) => {
    const inDept = positions.filter((p) => p.department === dept);
    const nextOrder = inDept.reduce((m, p) => Math.max(m, p.sortOrder), -1) + 1;
    setDraft(emptyDraft(dept, nextOrder, areaKey));
    setDialogOpen(true);
  };

  const openEdit = (p: Position) => {
    setDraft(positionToDraft(p));
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) { toast.error('Name ist erforderlich'); return; }

    const key = draft.id ? draft.key : slugifyKey(name);
    if (!key) { toast.error('Aus diesem Namen lässt sich kein gültiger Schlüssel bilden'); return; }

    // Kollisionsprüfung nur bei NEUEN Positionen (Key fix bei Bearbeitung).
    if (!draft.id && positions.some(p => p.key === key && p.department === draft.department)) {
      toast.error(`Schlüssel "${key}" existiert in dieser Abteilung bereits`);
      return;
    }

    setBusy(true);
    try {
      await save(draftToSave({ ...draft, key, name }));
      toast.success(draft.id ? 'Position aktualisiert' : 'Position angelegt');
      setDialogOpen(false);
      setDraft(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Speichern fehlgeschlagen');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (p: Position) => {
    if (!window.confirm(
      `Position „${p.name}" wirklich löschen?\n\nMitarbeitende, die diese Position als Haupt-/Zweitposition haben, verlieren die Zuordnung.`,
    )) return;
    try {
      await remove(p.id);
      toast.success('Position gelöscht');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Löschen fehlgeschlagen');
    }
  };

  const handleSeed = async () => {
    setBusy(true);
    try {
      await seed();
      toast.success('Standard-Positionen angelegt');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Standard-Positionen konnten nicht angelegt werden');
    } finally {
      setBusy(false);
    }
  };

  const handleApplyDefaults = async () => {
    setBusy(true);
    try {
      await applyDefaults();
      toast.success('Standard-Positionen angewendet');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Standard-Positionen konnten nicht angewendet werden');
    } finally {
      setBusy(false);
    }
  };

  const move = async (list: Position[], index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= list.length) return;
    const a = list[index];
    const b = list[target];
    try {
      await Promise.all([
        save(draftToSave({ ...positionToDraft(a), sortOrder: b.sortOrder })),
        save(draftToSave({ ...positionToDraft(b), sortOrder: a.sortOrder })),
      ]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Reihenfolge konnte nicht geändert werden');
    }
  };

  const isEmpty = !loading && positions.length === 0;

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <LayoutGrid className="h-5 w-5 text-violet-600" />
          <h1 className="text-lg font-semibold">Positionen</h1>
        </div>
        {positions.length > 0 && tab === 'stammdaten' && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="outline" className="gap-1" disabled={busy}>
                <Sparkles className="h-4 w-4" /> Standard-Positionen anwenden
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Standard-Positionen anwenden?</AlertDialogTitle>
                <AlertDialogDescription>
                  Legt die Standard-Positionen an bzw. aktualisiert gleichnamige
                  (per Slug) und deaktiviert alle übrigen Positionen. Bestehende
                  Mitarbeiterdaten und Zuordnungen bleiben erhalten — übrige
                  Positionen werden nur deaktiviert, nicht gelöscht.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Abbrechen</AlertDialogCancel>
                <AlertDialogAction onClick={handleApplyDefaults}>Anwenden</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>

      <Tabs value={tab} onValueChange={(v) => setSearchParams(v === 'matrix' ? {} : { tab: v }, { replace: true })}>
        <TabsList>
          <TabsTrigger value="matrix" data-testid="tab-matrix">Matrix</TabsTrigger>
          <TabsTrigger value="stammdaten" data-testid="tab-stammdaten">Stammdaten</TabsTrigger>
        </TabsList>

        <TabsContent value="matrix" className="mt-3 space-y-3">
          <p className="text-sm text-muted-foreground">
            Wer hat welche Position/Qualifikation? Gleiche Zuordnung wie im
            Personalstamm («Positionen/Qualifikationen») — Änderungen wirken
            sofort überall (Personalstamm, Positions-Pop-up, Dienstplan-Vorschläge).
          </p>
          <PositionMatrix
            positions={positions}
            tenantId={tenantId}
            dynamicHintFor={staticDynamicRuleHint}
          />
        </TabsContent>

        <TabsContent value="stammdaten" className="mt-3 space-y-4">
      <p className="text-sm text-muted-foreground">
        Positionen / Stationen je Abteilung. Werden im Personalstamm und in der
        Dienstplanung zur Zuordnung der Mitarbeitenden verwendet.
      </p>

      {error && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-3 text-sm flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {loading && <p className="text-sm text-muted-foreground">Lädt…</p>}

      {isEmpty && (
        <Card>
          <CardContent className="py-8 text-center space-y-3">
            <LayoutGrid className="h-8 w-8 text-muted-foreground mx-auto opacity-40" />
            <p className="text-sm text-muted-foreground">
              Noch keine Positionen vorhanden.
            </p>
            <Button onClick={handleSeed} disabled={busy} className="gap-1">
              <Sparkles className="h-4 w-4" /> Standard-Positionen anlegen
            </Button>
          </CardContent>
        </Card>
      )}

      {!loading && positions.length > 0 && (
        <label className="flex w-fit items-center gap-2 cursor-pointer select-none">
          <Switch checked={showInactive} onCheckedChange={setShowInactive} />
          <span className="text-sm text-muted-foreground">Inaktive Positionen anzeigen</span>
        </label>
      )}

      {!loading && positions.length > 0 && DEPARTMENTS.map(dept => (
        <Card key={dept}>
          <CardHeader className="pb-2 pt-4">
            <CardTitle className="text-sm">
              <Badge variant="outline" className={cn('text-xs border', DEPT_BADGE_CLASS[dept])}>
                {DEPT_LABEL[dept]}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-4">
            {grouped[dept].map(group => {
              const areaName = group.area ? group.area.name : 'Ohne Bereich';
              return (
                <div key={group.area?.key ?? '__none__'} className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {areaName}
                    </h3>
                    {group.area && (
                      <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => openNew(dept, group.area!.key)}>
                        <Plus className="h-3.5 w-3.5" /> Position
                      </Button>
                    )}
                  </div>
                  {group.positions.length === 0 ? (
                    <p className="text-xs text-muted-foreground italic py-1 pl-1">Keine Position in diesem Bereich.</p>
                  ) : (
                    <ul className="divide-y rounded-md border">
                      {group.positions.map((p, idx) => (
                        <li key={p.id} className={cn('flex items-center gap-3 py-2 px-2', !p.active && 'opacity-60')}>
                          <span
                            className="flex items-center justify-center h-7 w-7 rounded-md shrink-0"
                            style={{ backgroundColor: (p.color ?? DEPT_DEFAULT_COLOR[dept]) + '22', color: p.color ?? DEPT_DEFAULT_COLOR[dept] }}
                          >
                            <PositionIcon name={p.icon} className="h-4 w-4" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className={cn('text-sm font-medium truncate', !p.active && 'line-through text-muted-foreground')}>
                                {p.name}
                              </span>
                              {!p.active && <Badge variant="secondary" className="text-[10px]">inaktiv</Badge>}
                            </div>
                            <span className="text-[10px] text-muted-foreground font-mono">{p.key}</span>
                          </div>
                          <div className="flex items-center gap-0.5 shrink-0">
                            <Button size="icon" variant="ghost" className="h-7 w-7" disabled={idx === 0} onClick={() => move(group.positions, idx, -1)} title="Nach oben">
                              <ArrowUp className="h-3.5 w-3.5" />
                            </Button>
                            <Button size="icon" variant="ghost" className="h-7 w-7" disabled={idx === group.positions.length - 1} onClick={() => move(group.positions, idx, 1)} title="Nach unten">
                              <ArrowDown className="h-3.5 w-3.5" />
                            </Button>
                            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openEdit(p)} title="Bearbeiten">
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-red-600 hover:text-red-700" onClick={() => handleDelete(p)} title="Löschen">
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      ))}
        </TabsContent>
      </Tabs>

      {/* ── Anlegen / Bearbeiten ─────────────────────────────────────────── */}
      <Dialog open={dialogOpen} onOpenChange={v => { if (!v) { setDialogOpen(false); setDraft(null); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{draft?.id ? 'Position bearbeiten' : 'Neue Position'}</DialogTitle>
            <DialogDescription className="text-xs">
              {draft?.id
                ? 'Der Schlüssel bleibt fest, damit bestehende Zuordnungen erhalten bleiben.'
                : 'Der Schlüssel wird automatisch aus dem Namen abgeleitet.'}
            </DialogDescription>
          </DialogHeader>

          {draft && (
            <div className="space-y-4">
              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">Name</Label>
                <Input
                  autoFocus
                  value={draft.name}
                  onChange={e => setDraft(d => d ? { ...d, name: e.target.value } : d)}
                  placeholder="z.B. Chef de Rang"
                />
                {!draft.id && draft.name.trim() && (
                  <p className="text-[10px] text-muted-foreground mt-1 font-mono">Schlüssel: {slugifyKey(draft.name) || '—'}</p>
                )}
              </div>

              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">Abteilung</Label>
                <Select
                  value={draft.department}
                  onValueChange={v => setDraft(d => d ? { ...d, department: v as Department, departmentGroup: '' } : d)}
                  disabled={!!draft.id}
                >
                  <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DEPARTMENTS.map(dep => (
                      <SelectItem key={dep} value={dep}>{DEPT_LABEL[dep]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">Bereich</Label>
                <Select
                  value={draft.departmentGroup || '__none__'}
                  onValueChange={v => setDraft(d => d ? { ...d, departmentGroup: v === '__none__' ? '' : v } : d)}
                >
                  <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Ohne Bereich</SelectItem>
                    {areasForDepartment(draft.department).map(area => (
                      <SelectItem key={area.key} value={area.key}>{area.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">Farbe</Label>
                <div className="flex flex-wrap gap-1.5">
                  {POSITION_COLORS.map(c => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setDraft(d => d ? { ...d, color: c } : d)}
                      className={cn(
                        'h-6 w-6 rounded-full border-2 transition-transform',
                        draft.color === c ? 'border-foreground scale-110' : 'border-transparent',
                      )}
                      style={{ backgroundColor: c }}
                      title={c}
                    />
                  ))}
                </div>
              </div>

              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">Icon</Label>
                <div className="flex flex-wrap gap-1.5">
                  {POSITION_ICONS.map(ic => (
                    <button
                      key={ic}
                      type="button"
                      onClick={() => setDraft(d => d ? { ...d, icon: ic } : d)}
                      className={cn(
                        'h-8 w-8 rounded-md border flex items-center justify-center transition-colors',
                        draft.icon === ic ? 'border-foreground bg-muted' : 'border-border hover:bg-muted/50',
                      )}
                      title={ic}
                    >
                      <PositionIcon name={ic} className="h-4 w-4" />
                    </button>
                  ))}
                </div>
              </div>

              <label className="flex items-center justify-between gap-2 cursor-pointer">
                <span className="text-sm">Aktiv</span>
                <Switch
                  checked={draft.active}
                  onCheckedChange={v => setDraft(d => d ? { ...d, active: v } : d)}
                />
              </label>

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="ghost" onClick={() => { setDialogOpen(false); setDraft(null); }}>Abbrechen</Button>
                <Button onClick={handleSave} disabled={busy}>{busy ? 'Speichert…' : 'Speichern'}</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <div className="pt-2">
        <Button variant="ghost" size="sm" onClick={() => void reload()} disabled={loading}>
          Aktualisieren
        </Button>
      </div>
    </div>
  );
}
