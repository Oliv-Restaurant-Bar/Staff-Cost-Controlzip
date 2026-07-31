/**
 * Rezensionen — manuelle Erfassung von Bewertungs-Kennzahlen (ohne API-Anbindung)
 * ==============================================================================
 * - Monatliche Erfassung pro Plattform (Ø neue, Anzahl neue, kumuliert, Ø gesamt, Notiz)
 * - Optional: Einzelrezensionen (→ Antwortquote)
 * - Kennzahlen-Box (Plattform umschaltbar) + Verlaufsdiagramm
 * - Mandantengetrennt (reviews_data:<tenant>); Editieren nur berechtigte Rollen,
 *   Gäste rein lesend.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Star, Plus, Pencil, Trash2, Loader2, MessageSquare } from 'lucide-react';
import {
  ResponsiveContainer, ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartsTooltip, Legend,
} from 'recharts';

import { Button } from '@/components/ui/button';
import { ReviewsWeeklyTracker } from '@/components/reviews/ReviewsWeeklyTracker';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { KpiCard, KpiGrid } from '@/components/ui/kpi-card';
import { useToast } from '@/hooks/use-toast';
import { usePermissions } from '@/hooks/usePermissions';
import { useTenant } from '@/contexts/TenantContext';
import {
  fetchReviewsData, upsertMonthlyRow, deleteMonthlyRow, upsertSingleReview, deleteSingleReview,
  computeReviewKpis, computeReviewTrend, newReviewId,
  type ReviewsData, type MonthlyReviewRow, type SingleReview,
} from '@/lib/reviews-store';
import { cn } from '@/lib/utils';

const DEFAULT_PLATFORMS = ['Google', 'TripAdvisor'];
const fmt1 = (v: number) => v.toFixed(1);

// ── Formular-Zustände ────────────────────────────────────────────────────────

interface MonthlyForm {
  id: string | null;
  month: string;
  platform: string;
  platformCustom: string;
  avgRating: string;
  newCount: string;
  totalCount: string;
  totalAvg: string;
  note: string;
}

const emptyMonthlyForm = (): MonthlyForm => ({
  id: null, month: format(new Date(), 'yyyy-MM'), platform: 'Google', platformCustom: '',
  avgRating: '', newCount: '', totalCount: '', totalAvg: '', note: '',
});

interface SingleForm {
  id: string | null;
  date: string;
  platform: string;
  platformCustom: string;
  stars: string;
  text: string;
  author: string;
  answered: boolean;
}

const emptySingleForm = (): SingleForm => ({
  id: null, date: format(new Date(), 'yyyy-MM-dd'), platform: 'Google', platformCustom: '',
  stars: '5', text: '', author: '', answered: false,
});

const parseNum = (s: string): number | null => {
  const t = s.trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

export default function Rezensionen() {
  const { tenantId, tenant } = useTenant();
  const { isAdmin, isGuest, isBeaulieuManager } = usePermissions();
  const { toast } = useToast();

  // Editieren: Admin (ohne Gast-Sessions) + Beaulieu-GF; Gäste rein lesend.
  const canEdit = (isAdmin && !isGuest) || isBeaulieuManager;

  const [data, setData] = useState<ReviewsData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [platformFilter, setPlatformFilter] = useState<string>('__all__');
  const [monthlyForm, setMonthlyForm] = useState<MonthlyForm | null>(null);
  const [singleForm, setSingleForm] = useState<SingleForm | null>(null);

  useEffect(() => {
    // State-Reset bei Mandantenwechsel — nie Werte des anderen Mandanten zeigen.
    setData(null); setLoadError(null); setMonthlyForm(null); setSingleForm(null);
    setPlatformFilter('__all__');
    let cancelled = false;
    fetchReviewsData(tenantId)
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [tenantId]);

  const platforms = useMemo(() => {
    const set = new Set(DEFAULT_PLATFORMS);
    for (const r of data?.monthlyRows ?? []) set.add(r.platform);
    for (const r of data?.singleReviews ?? []) set.add(r.platform);
    return [...set].sort((a, b) => a.localeCompare(b, 'de'));
  }, [data]);

  const currentMonth = format(new Date(), 'yyyy-MM');
  const filterValue = platformFilter === '__all__' ? null : platformFilter;
  const kpis = useMemo(
    () => data ? computeReviewKpis(data, currentMonth, filterValue) : null,
    [data, currentMonth, filterValue],
  );
  const trend = useMemo(
    () => data ? computeReviewTrend(data.monthlyRows, filterValue) : [],
    [data, filterValue],
  );

  const sortedRows = useMemo(
    () => [...(data?.monthlyRows ?? [])].sort((a, b) =>
      b.month.localeCompare(a.month) || a.platform.localeCompare(b.platform, 'de')),
    [data],
  );
  const sortedSingles = useMemo(
    () => [...(data?.singleReviews ?? [])].sort((a, b) => b.date.localeCompare(a.date)),
    [data],
  );

  const runSave = useCallback(async (fn: () => Promise<ReviewsData>, okMsg: string) => {
    setSaving(true);
    try {
      const next = await fn();
      setData(next);
      toast({ title: okMsg });
      return true;
    } catch (e) {
      toast({
        title: 'Speichern fehlgeschlagen',
        description: e instanceof Error ? e.message : String(e),
        variant: 'destructive',
      });
      return false;
    } finally {
      setSaving(false);
    }
  }, [toast]);

  // ── Monatszeile speichern ──────────────────────────────────────────────────
  const submitMonthly = async () => {
    if (!monthlyForm) return;
    const platform = (monthlyForm.platform === '__custom__'
      ? monthlyForm.platformCustom : monthlyForm.platform).trim();
    if (!/^\d{4}-\d{2}$/.test(monthlyForm.month)) {
      toast({ title: 'Bitte einen gültigen Monat wählen.', variant: 'destructive' }); return;
    }
    if (!platform) {
      toast({ title: 'Bitte eine Plattform angeben.', variant: 'destructive' }); return;
    }
    const avgRating = parseNum(monthlyForm.avgRating);
    const totalAvg = parseNum(monthlyForm.totalAvg);
    for (const [label, v] of [['Ø-Bewertung', avgRating], ['Ø-Gesamtbewertung', totalAvg]] as const) {
      if (v != null && (v < 0 || v > 5)) {
        toast({ title: `${label} muss zwischen 0.0 und 5.0 liegen.`, variant: 'destructive' }); return;
      }
    }
    const newCount = parseNum(monthlyForm.newCount);
    const totalCount = parseNum(monthlyForm.totalCount);
    for (const [label, v] of [['Anzahl neue', newCount], ['Gesamtzahl', totalCount]] as const) {
      if (v != null && (v < 0 || !Number.isInteger(v))) {
        toast({ title: `${label} muss eine ganze Zahl ≥ 0 sein.`, variant: 'destructive' }); return;
      }
    }
    const existing = monthlyForm.id ? data?.monthlyRows.find(r => r.id === monthlyForm.id) : undefined;
    // Duplikat-Schutz: pro Monat+Plattform genau eine Zeile.
    const dupe = data?.monthlyRows.find(r =>
      r.id !== monthlyForm.id && r.month === monthlyForm.month
      && r.platform.toLowerCase() === platform.toLowerCase());
    if (dupe) {
      toast({
        title: 'Für diesen Monat und diese Plattform existiert bereits eine Zeile.',
        description: 'Bitte die bestehende Zeile bearbeiten.',
        variant: 'destructive',
      });
      return;
    }
    const row: MonthlyReviewRow = {
      id: monthlyForm.id ?? newReviewId('rev'),
      month: monthlyForm.month,
      platform,
      avgRating, newCount, totalCount, totalAvg,
      note: monthlyForm.note.trim() || undefined,
      updatedAt: existing?.updatedAt ?? '',
    };
    const ok = await runSave(() => upsertMonthlyRow(tenantId, row),
      monthlyForm.id ? 'Monatszeile aktualisiert.' : 'Monatszeile erfasst.');
    if (ok) setMonthlyForm(null);
  };

  const editMonthly = (r: MonthlyReviewRow) => setMonthlyForm({
    id: r.id, month: r.month,
    platform: platforms.includes(r.platform) ? r.platform : '__custom__',
    platformCustom: platforms.includes(r.platform) ? '' : r.platform,
    avgRating: r.avgRating != null ? String(r.avgRating) : '',
    newCount: r.newCount != null ? String(r.newCount) : '',
    totalCount: r.totalCount != null ? String(r.totalCount) : '',
    totalAvg: r.totalAvg != null ? String(r.totalAvg) : '',
    note: r.note ?? '',
  });

  // ── Einzelrezension speichern ──────────────────────────────────────────────
  const submitSingle = async () => {
    if (!singleForm) return;
    const platform = (singleForm.platform === '__custom__'
      ? singleForm.platformCustom : singleForm.platform).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(singleForm.date)) {
      toast({ title: 'Bitte ein gültiges Datum wählen.', variant: 'destructive' }); return;
    }
    if (!platform) {
      toast({ title: 'Bitte eine Plattform angeben.', variant: 'destructive' }); return;
    }
    const stars = parseNum(singleForm.stars);
    if (stars == null || stars < 1 || stars > 5 || !Number.isInteger(stars)) {
      toast({ title: 'Sterne müssen 1–5 sein.', variant: 'destructive' }); return;
    }
    const existing = singleForm.id ? data?.singleReviews.find(r => r.id === singleForm.id) : undefined;
    const review: SingleReview = {
      id: singleForm.id ?? newReviewId('sr'),
      date: singleForm.date,
      platform,
      stars,
      text: singleForm.text.trim(),
      author: singleForm.author.trim() || undefined,
      answered: singleForm.answered,
      updatedAt: existing?.updatedAt ?? '',
    };
    const ok = await runSave(() => upsertSingleReview(tenantId, review),
      singleForm.id ? 'Rezension aktualisiert.' : 'Rezension erfasst.');
    if (ok) setSingleForm(null);
  };

  const editSingle = (r: SingleReview) => setSingleForm({
    id: r.id, date: r.date,
    platform: platforms.includes(r.platform) ? r.platform : '__custom__',
    platformCustom: platforms.includes(r.platform) ? '' : r.platform,
    stars: String(r.stars), text: r.text, author: r.author ?? '', answered: r.answered,
  });

  const platformSelect = (
    value: string, customValue: string,
    onChange: (v: string) => void, onCustomChange: (v: string) => void,
  ) => (
    <div className="flex gap-2">
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
        <SelectContent>
          {platforms.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
          <SelectItem value="__custom__">Andere …</SelectItem>
        </SelectContent>
      </Select>
      {value === '__custom__' && (
        <Input className="h-9 w-36" placeholder="Plattform" value={customValue}
          onChange={e => onCustomChange(e.target.value)} />
      )}
    </div>
  );

  return (
    <div className="bg-background">
      <main className="px-4 py-6 lg:px-8 space-y-6 max-w-6xl mx-auto">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Star className="h-6 w-6 text-amber-500" />
              Rezensionen — {tenant.shortName}
            </h1>
            <p className="text-sm text-muted-foreground">
              Manuell gepflegte Bewertungs-Kennzahlen (ohne API-Anbindung).
              {!canEdit && ' Nur Leseansicht.'}
            </p>
          </div>
          <Select value={platformFilter} onValueChange={setPlatformFilter}>
            <SelectTrigger className="h-9 w-48" data-testid="reviews-platform-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Alle Plattformen</SelectItem>
              {platforms.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {loadError && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
            {loadError}
          </div>
        )}
        {!data && !loadError && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Lade Rezensionen …
          </div>
        )}

        {data && kpis && (
          <>
            {/* Kennzahlen-Box */}
            <KpiGrid>
              <KpiCard
                label={`Ø-Gesamtbewertung${filterValue ? ` (${filterValue})` : ''}`}
                value={kpis.overallAvg != null ? `${fmt1(kpis.overallAvg)} ★` : '—'}
                sub={filterValue ? undefined : 'gewichtet über Plattformen'}
                tone={kpis.overallAvg != null ? (kpis.overallAvg >= 4.3 ? 'good' : kpis.overallAvg >= 3.8 ? 'warn' : 'critical') : 'neutral'}
                data-testid="reviews-kpi-avg"
              />
              <KpiCard
                label="Rezensionen gesamt"
                value={kpis.totalCount != null ? kpis.totalCount.toLocaleString('de-CH') : '—'}
                sub="kumuliert, letzter gepflegter Stand"
                tone="info"
                data-testid="reviews-kpi-total"
              />
              <KpiCard
                label={`Neue im ${format(new Date(), 'MM/yyyy')}`}
                value={kpis.newInMonth != null ? kpis.newInMonth : '—'}
                sub={kpis.newInMonth == null ? 'Monat noch nicht erfasst' : undefined}
                tone="neutral"
                data-testid="reviews-kpi-new"
              />
              <KpiCard
                label="Antwortquote"
                value={kpis.responseRate != null ? `${Math.round(kpis.responseRate * 100)} %` : '—'}
                sub={kpis.responseRate == null ? 'keine Einzelrezensionen gepflegt' : 'aus Einzelrezensionen'}
                tone={kpis.responseRate != null ? (kpis.responseRate >= 0.8 ? 'good' : 'warn') : 'neutral'}
                data-testid="reviews-kpi-response"
              />
            </KpiGrid>

            {/* Verlauf */}
            {trend.length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">
                    Verlauf — Ø-Bewertung &amp; neue Rezensionen{filterValue ? ` (${filterValue})` : ''}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={trend} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                        <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                        <YAxis yAxisId="count" tick={{ fontSize: 11 }} allowDecimals={false} />
                        <YAxis yAxisId="rating" orientation="right" domain={[0, 5]} tick={{ fontSize: 11 }} />
                        <RechartsTooltip
                          formatter={(value: number, name: string) =>
                            name === 'Ø-Bewertung' ? [fmt1(value), name] : [value, name]}
                        />
                        <Legend wrapperStyle={{ fontSize: 12 }} />
                        <Bar yAxisId="count" dataKey="newCount" name="Neue Rezensionen"
                          fill="hsl(var(--primary) / 0.35)" radius={[3, 3, 0, 0]} />
                        <Line yAxisId="rating" type="monotone" dataKey="avgRating" name="Ø-Bewertung"
                          stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }} connectNulls />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Monatliche Erfassung */}
            <Card>
              <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">Monatliche Erfassung pro Plattform</CardTitle>
                {canEdit && !monthlyForm && (
                  <Button size="sm" onClick={() => setMonthlyForm(emptyMonthlyForm())}
                    data-testid="reviews-add-monthly">
                    <Plus className="h-4 w-4 mr-1" /> Monat erfassen
                  </Button>
                )}
              </CardHeader>
              <CardContent className="space-y-4">
                {canEdit && monthlyForm && (
                  <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <div className="space-y-1">
                        <label className="text-xs text-muted-foreground">Monat</label>
                        <Input type="month" className="h-9" value={monthlyForm.month}
                          onChange={e => setMonthlyForm({ ...monthlyForm, month: e.target.value })} />
                      </div>
                      <div className="space-y-1 col-span-2 md:col-span-1">
                        <label className="text-xs text-muted-foreground">Plattform</label>
                        {platformSelect(
                          monthlyForm.platform, monthlyForm.platformCustom,
                          v => setMonthlyForm({ ...monthlyForm, platform: v }),
                          v => setMonthlyForm({ ...monthlyForm, platformCustom: v }),
                        )}
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-muted-foreground">Ø-Bewertung neue (0.0–5.0)</label>
                        <Input className="h-9" inputMode="decimal" placeholder="z. B. 4.6"
                          value={monthlyForm.avgRating}
                          onChange={e => setMonthlyForm({ ...monthlyForm, avgRating: e.target.value })} />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-muted-foreground">Anzahl neue im Monat</label>
                        <Input className="h-9" inputMode="numeric" placeholder="z. B. 8"
                          value={monthlyForm.newCount}
                          onChange={e => setMonthlyForm({ ...monthlyForm, newCount: e.target.value })} />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-muted-foreground">Kumulierte Gesamtzahl</label>
                        <Input className="h-9" inputMode="numeric" placeholder="z. B. 512"
                          value={monthlyForm.totalCount}
                          onChange={e => setMonthlyForm({ ...monthlyForm, totalCount: e.target.value })} />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-muted-foreground">Ø-Gesamtbewertung (0.0–5.0)</label>
                        <Input className="h-9" inputMode="decimal" placeholder="z. B. 4.5"
                          value={monthlyForm.totalAvg}
                          onChange={e => setMonthlyForm({ ...monthlyForm, totalAvg: e.target.value })} />
                      </div>
                      <div className="space-y-1 col-span-2">
                        <label className="text-xs text-muted-foreground">Notiz (optional)</label>
                        <Input className="h-9" value={monthlyForm.note}
                          onChange={e => setMonthlyForm({ ...monthlyForm, note: e.target.value })} />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={submitMonthly} disabled={saving}
                        data-testid="reviews-save-monthly">
                        {saving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                        {monthlyForm.id ? 'Aktualisieren' : 'Speichern'}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setMonthlyForm(null)}>
                        Abbrechen
                      </Button>
                    </div>
                  </div>
                )}

                <div className="overflow-x-auto">
                  <table className="w-full text-xs min-w-[640px]">
                    <thead>
                      <tr className="text-[11px] text-muted-foreground border-b border-border bg-muted/10">
                        <th className="text-left px-3 py-1.5 font-medium">Monat</th>
                        <th className="text-left px-3 py-1.5 font-medium">Plattform</th>
                        <th className="text-right px-3 py-1.5 font-medium">Ø neue</th>
                        <th className="text-right px-3 py-1.5 font-medium">Neue</th>
                        <th className="text-right px-3 py-1.5 font-medium">Gesamt</th>
                        <th className="text-right px-3 py-1.5 font-medium">Ø gesamt</th>
                        <th className="text-left px-3 py-1.5 font-medium">Notiz</th>
                        {canEdit && <th className="px-2 py-1.5" />}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/50">
                      {sortedRows.length === 0 && (
                        <tr className="text-muted-foreground italic">
                          <td className="px-3 py-2">2026-06</td>
                          <td className="px-3 py-2">Google</td>
                          <td className="px-3 py-2 text-right">4.6</td>
                          <td className="px-3 py-2 text-right">8</td>
                          <td className="px-3 py-2 text-right">512</td>
                          <td className="px-3 py-2 text-right">4.5</td>
                          <td className="px-3 py-2">Beispielzeile — so sieht ein Eintrag aus</td>
                          {canEdit && <td />}
                        </tr>
                      )}
                      {sortedRows.map(r => (
                        <tr key={r.id} className="hover:bg-muted/30 transition-colors"
                          data-testid={`reviews-row-${r.month}-${r.platform}`}>
                          <td className="px-3 py-1.5 font-mono">{r.month}</td>
                          <td className="px-3 py-1.5">{r.platform}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{r.avgRating != null ? fmt1(r.avgRating) : '—'}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{r.newCount ?? '—'}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{r.totalCount ?? '—'}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{r.totalAvg != null ? fmt1(r.totalAvg) : '—'}</td>
                          <td className="px-3 py-1.5 text-muted-foreground max-w-[220px] truncate">{r.note ?? ''}</td>
                          {canEdit && (
                            <td className="px-2 py-1.5 whitespace-nowrap text-right">
                              <Button size="icon" variant="ghost" className="h-6 w-6"
                                onClick={() => editMonthly(r)} title="Bearbeiten">
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive"
                                disabled={saving}
                                onClick={() => runSave(() => deleteMonthlyRow(tenantId, r), 'Monatszeile gelöscht.')}
                                title="Löschen">
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>

            {/* Wochentracking nach Sternen (gleiche Ansicht wie im Cockpit) */}
            <Card>
              <CardContent className="pt-4">
                <ReviewsWeeklyTracker reviews={data?.singleReviews ?? []} />
              </CardContent>
            </Card>

            {/* Einzelrezensionen */}
            <Card>
              <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base flex items-center gap-2">
                  <MessageSquare className="h-4 w-4" />
                  Einzelrezensionen (optional, für bemerkenswerte Fälle)
                </CardTitle>
                {canEdit && !singleForm && (
                  <Button size="sm" variant="outline" onClick={() => setSingleForm(emptySingleForm())}
                    data-testid="reviews-add-single">
                    <Plus className="h-4 w-4 mr-1" /> Rezension festhalten
                  </Button>
                )}
              </CardHeader>
              <CardContent className="space-y-4">
                {canEdit && singleForm && (
                  <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <div className="space-y-1">
                        <label className="text-xs text-muted-foreground">Datum</label>
                        <Input type="date" className="h-9" value={singleForm.date}
                          onChange={e => setSingleForm({ ...singleForm, date: e.target.value })} />
                      </div>
                      <div className="space-y-1 col-span-2 md:col-span-1">
                        <label className="text-xs text-muted-foreground">Plattform</label>
                        {platformSelect(
                          singleForm.platform, singleForm.platformCustom,
                          v => setSingleForm({ ...singleForm, platform: v }),
                          v => setSingleForm({ ...singleForm, platformCustom: v }),
                        )}
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-muted-foreground">Sterne (1–5)</label>
                        <Select value={singleForm.stars}
                          onValueChange={v => setSingleForm({ ...singleForm, stars: v })}>
                          <SelectTrigger className="h-9 w-24"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {[1, 2, 3, 4, 5].map(s => (
                              <SelectItem key={s} value={String(s)}>{s} ★</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-muted-foreground">Autor (optional)</label>
                        <Input className="h-9" value={singleForm.author}
                          onChange={e => setSingleForm({ ...singleForm, author: e.target.value })} />
                      </div>
                      <div className="space-y-1 col-span-2 md:col-span-3">
                        <label className="text-xs text-muted-foreground">Text</label>
                        <Textarea rows={2} value={singleForm.text}
                          onChange={e => setSingleForm({ ...singleForm, text: e.target.value })} />
                      </div>
                      <div className="flex items-end gap-2 pb-1">
                        <Checkbox id="rez-answered" checked={singleForm.answered}
                          onCheckedChange={v => setSingleForm({ ...singleForm, answered: v === true })} />
                        <label htmlFor="rez-answered" className="text-sm">beantwortet</label>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={submitSingle} disabled={saving}
                        data-testid="reviews-save-single">
                        {saving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                        {singleForm.id ? 'Aktualisieren' : 'Speichern'}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setSingleForm(null)}>
                        Abbrechen
                      </Button>
                    </div>
                  </div>
                )}

                {sortedSingles.length === 0 ? (
                  <div className="space-y-2">
                    {/* Beispielzeile — wird NICHT gespeichert, verschwindet mit dem ersten Eintrag */}
                    <div className="rounded-lg border border-dashed border-border/70 p-3 flex flex-wrap items-start gap-x-4 gap-y-1 text-sm italic text-muted-foreground"
                      data-testid="single-review-example">
                      <span className="font-mono text-xs">2026-07-28</span>
                      <span className="font-medium">Google</span>
                      <span className="text-amber-600/70 font-semibold whitespace-nowrap not-italic">★★★★★</span>
                      <span className="text-xs px-1.5 py-0.5 rounded bg-muted">beantwortet</span>
                      <span className="text-xs">von M. Muster</span>
                      <p className="w-full">Beispielzeile — «Super Service, gerne wieder!» (so sieht ein Eintrag aus)</p>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Noch keine Einzelrezensionen erfasst. Wird hier gepflegt, berechnen sich daraus Antwortquote und Wochentracking.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {sortedSingles.map(r => (
                      <div key={r.id}
                        className="rounded-lg border border-border/70 p-3 flex flex-wrap items-start gap-x-4 gap-y-1 text-sm">
                        <span className="font-mono text-xs text-muted-foreground">{r.date}</span>
                        <span className="font-medium">{r.platform}</span>
                        <span className="text-amber-600 font-semibold whitespace-nowrap">{'★'.repeat(r.stars)}{'☆'.repeat(5 - r.stars)}</span>
                        <span className={cn(
                          'text-xs px-1.5 py-0.5 rounded',
                          r.answered
                            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                            : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
                        )}>
                          {r.answered ? 'beantwortet' : 'offen'}
                        </span>
                        {r.author && <span className="text-muted-foreground text-xs">von {r.author}</span>}
                        {r.text && <p className="w-full text-muted-foreground">{r.text}</p>}
                        {canEdit && (
                          <span className="ml-auto whitespace-nowrap">
                            <Button size="icon" variant="ghost" className="h-6 w-6"
                              onClick={() => editSingle(r)} title="Bearbeiten">
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive"
                              disabled={saving}
                              onClick={() => runSave(() => deleteSingleReview(tenantId, r), 'Rezension gelöscht.')}
                              title="Löschen">
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
