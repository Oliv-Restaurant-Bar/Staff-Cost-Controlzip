/**
 * Positionen — Verwaltung der Positions-/Stationsstammdaten (Personalbedarf-Grundlage).
 * ──────────────────────────────────────────────────────────────────────────────
 * Admin-Seite (Route /positionen, canAccessModule('positionen')). Positionen sind
 * je Abteilung (Service/Küche) konfigurierbar: Name, Farbe, Icon, Reihenfolge,
 * aktiv. Mitarbeitende referenzieren den stabilen `key` — daher ist der Key nach
 * dem Anlegen NICHT mehr änderbar (sonst verwaisen Zuordnungen).
 */
import { useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
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
import { cn } from '@/lib/utils';
import type { Department } from '@/types/personnel';
import type { Position } from '@/types/positions';
import { usePositions } from '@/hooks/usePositions';
import { usePermissions } from '@/hooks/usePermissions';
import {
  DEPARTMENTS, POSITION_COLORS, POSITION_ICONS,
  DEPT_DEFAULT_COLOR, DEPT_DEFAULT_ICON,
  slugifyKey, positionsForDepartment,
} from '@/lib/position-utils';
import { DEPT_LABEL, DEPT_BADGE_CLASS } from '@/lib/station-config';
import { PositionIcon } from '@/components/PositionIcon';

interface DraftState {
  id?: string;
  key: string;
  name: string;
  department: Department;
  color: string;
  icon: string;
  active: boolean;
  sortOrder: number;
}

function emptyDraft(dept: Department, sortOrder: number): DraftState {
  return {
    key: '',
    name: '',
    department: dept,
    color: DEPT_DEFAULT_COLOR[dept],
    icon: DEPT_DEFAULT_ICON[dept],
    active: true,
    sortOrder,
  };
}

export default function Positionen() {
  const { canAccessModule, isGuest } = usePermissions();
  const { positions, loading, error, save, remove, seed, reload } = usePositions();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [busy, setBusy] = useState(false);

  const grouped = useMemo(() => {
    const map: Record<Department, Position[]> = { service: [], 'küche': [] };
    for (const dept of DEPARTMENTS) {
      map[dept] = positionsForDepartment(positions, dept);
    }
    return map;
  }, [positions]);

  if (!canAccessModule('positionen')) {
    return <Navigate to="/personal" replace />;
  }

  const readOnly = isGuest;

  const openNew = (dept: Department) => {
    const nextOrder = (grouped[dept].reduce((m, p) => Math.max(m, p.sortOrder), -1)) + 1;
    setDraft(emptyDraft(dept, nextOrder));
    setDialogOpen(true);
  };

  const openEdit = (p: Position) => {
    setDraft({
      id: p.id,
      key: p.key,
      name: p.name,
      department: p.department,
      color: p.color ?? DEPT_DEFAULT_COLOR[p.department],
      icon: p.icon ?? DEPT_DEFAULT_ICON[p.department],
      active: p.active,
      sortOrder: p.sortOrder,
    });
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
      await save({
        id: draft.id,
        key,
        name,
        department: draft.department,
        color: draft.color,
        icon: draft.icon,
        sortOrder: draft.sortOrder,
        active: draft.active,
      });
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

  const move = async (dept: Department, index: number, dir: -1 | 1) => {
    const list = grouped[dept];
    const target = index + dir;
    if (target < 0 || target >= list.length) return;
    const a = list[index];
    const b = list[target];
    try {
      await Promise.all([
        save({ id: a.id, key: a.key, name: a.name, department: a.department, color: a.color ?? DEPT_DEFAULT_COLOR[a.department], icon: a.icon ?? DEPT_DEFAULT_ICON[a.department], sortOrder: b.sortOrder, active: a.active }),
        save({ id: b.id, key: b.key, name: b.name, department: b.department, color: b.color ?? DEPT_DEFAULT_COLOR[b.department], icon: b.icon ?? DEPT_DEFAULT_ICON[b.department], sortOrder: a.sortOrder, active: b.active }),
      ]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Reihenfolge konnte nicht geändert werden');
    }
  };

  const isEmpty = !loading && positions.length === 0;

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <LayoutGrid className="h-5 w-5 text-violet-600" />
          <h1 className="text-lg font-semibold">Positionen</h1>
        </div>
      </div>

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
            {!readOnly && (
              <Button onClick={handleSeed} disabled={busy} className="gap-1">
                <Sparkles className="h-4 w-4" /> Standard-Positionen anlegen
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {!loading && positions.length > 0 && DEPARTMENTS.map(dept => (
        <Card key={dept}>
          <CardHeader className="pb-2 pt-4">
            <CardTitle className="text-sm flex items-center justify-between">
              <Badge variant="outline" className={cn('text-xs border', DEPT_BADGE_CLASS[dept])}>
                {DEPT_LABEL[dept]}
              </Badge>
              {!readOnly && (
                <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => openNew(dept)}>
                  <Plus className="h-3.5 w-3.5" /> Position
                </Button>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {grouped[dept].length === 0 ? (
              <p className="text-xs text-muted-foreground italic py-2">Keine Positionen in dieser Abteilung.</p>
            ) : (
              <ul className="divide-y">
                {grouped[dept].map((p, idx) => (
                  <li key={p.id} className="flex items-center gap-3 py-2">
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
                    {!readOnly && (
                      <div className="flex items-center gap-0.5 shrink-0">
                        <Button size="icon" variant="ghost" className="h-7 w-7" disabled={idx === 0} onClick={() => move(dept, idx, -1)} title="Nach oben">
                          <ArrowUp className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="icon" variant="ghost" className="h-7 w-7" disabled={idx === grouped[dept].length - 1} onClick={() => move(dept, idx, 1)} title="Nach unten">
                          <ArrowDown className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openEdit(p)} title="Bearbeiten">
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="icon" variant="ghost" className="h-7 w-7 text-red-600 hover:text-red-700" onClick={() => handleDelete(p)} title="Löschen">
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ))}

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
                  onValueChange={v => setDraft(d => d ? { ...d, department: v as Department } : d)}
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
