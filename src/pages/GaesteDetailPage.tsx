/**
 * GaesteDetailPage — Gäste-CRM (Kundenakte)
 * ==========================================
 * Vollständige CRM-Kundenakte eines einzelnen Gastes in zwei Tabs:
 *
 *  - „Übersicht": Besuchsverhalten, Präferenzen, Risiko, Besuchstrend,
 *    CRM-Score und die filterbare Reservierungs-Historie.  Alle Kennzahlen
 *    werden LIVE aus den Einzelreservationen (`reservation_records`) berechnet
 *    (reservation-crm.ts / reservation-guest-profile.ts) — reine Leseansicht.
 *  - „CRM": MANUELL gepflegte Stammdaten/Flags/Notizen (`guest_crm_profiles`),
 *    bearbeitbar.  Diese Angaben sind STRIKT getrennt von den automatisch
 *    berechneten Kennzahlen und beeinflussen Segment/Score/Kampagnen NICHT.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  ArrowLeft, Loader2, CalendarCheck, CalendarX, Ban, Users as UsersIcon,
  Clock, CalendarRange, Repeat, Mail, Phone, MapPin, StickyNote,
  Sigma, Gauge, TrendingUp, TrendingDown, Minus, AlertTriangle,
  ShieldCheck, ShieldAlert, CalendarDays, Hash, Hourglass,
  LayoutGrid, Pencil, Save, RotateCcw, Crown, Star, Building2, UserCheck,
  BellRing, Lock, Cake, Languages, Utensils, Wine, Wheat,
  FileDown, FileSpreadsheet,
} from 'lucide-react';
import { format as fmtDate, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useTenant } from '@/contexts/TenantContext';
import { usePermissions } from '@/hooks/usePermissions';
import { useGuestSession } from '@/contexts/GuestSessionContext';
import { useToast } from '@/hooks/use-toast';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

import { fetchGuestById, fetchGuestReservations, type GuestReservationDisplay } from '@/lib/reservation-crm-db';
import {
  guestDetailMetrics, guestDisplayName, guestListMetricsFromDetail,
  simpleGuestStatus, SIMPLE_STATUS_LABEL,
  type GuestProfile,
} from '@/lib/reservation-crm';
import { overdueByDays, isOverdue, isAtRiskTier } from '@/lib/reservation-dashboard';
import {
  computeGuestPreferences, computeVisitTrend, computeCrmScore, totalPersonsOnVisits,
  filterReservationHistory, CRM_SCORE_TIER_LABEL,
  RESERVATION_HISTORY_HEADERS, reservationHistoryRowToCells,
  type HistoryFilter, type CrmScoreTier, type TrendDirection,
} from '@/lib/reservation-guest-profile';
import { downloadCsv, downloadXlsx } from '@/lib/table-export';
import { exportSlug } from '@/lib/export-cell';
import { fetchGuestCrmProfile, upsertGuestCrmProfile } from '@/lib/guest-crm-profile-db';
import {
  EMPTY_CRM_PROFILE, isCrmProfileDirty, manualCrmBadges,
  type GuestCrmProfile, type ManualBadge, type ManualBadgeKind,
} from '@/lib/guest-crm-profile';
import { SegmentBadge } from '@/components/crm/SegmentBadge';
import type { ReservationStatusNormalized } from '@/lib/reservation-import-parser';

// ── Formatierung ──────────────────────────────────────────────────────────────

const NUM0 = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const NUM1 = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function fdate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try { return fmtDate(parseISO(iso.slice(0, 10)), 'dd.MM.yyyy', { locale: de }); }
  catch { return iso; }
}

// ── Status-Darstellung ────────────────────────────────────────────────────────

const STATUS_LABEL: Record<ReservationStatusNormalized, string> = {
  completed: 'Abgeschlossen',
  cancelled: 'Storniert',
  noshow:    'No-Show',
  confirmed: 'Bestätigt',
  pending:   'Offen',
  unknown:   'Unbekannt',
};

const STATUS_CLASS: Record<ReservationStatusNormalized, string> = {
  completed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  cancelled: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300',
  noshow:    'bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300',
  confirmed: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
  pending:   'bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-300',
  unknown:   'bg-muted text-muted-foreground',
};

// ── CRM-Score-Stufen ──────────────────────────────────────────────────────────

const TIER_CLASS: Record<CrmScoreTier, string> = {
  niedrig:       'bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-300',
  mittel:        'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
  hoch:          'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  vip_potenzial: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
};

const TIER_BAR: Record<CrmScoreTier, string> = {
  niedrig:       'bg-slate-400',
  mittel:        'bg-blue-500',
  hoch:          'bg-emerald-500',
  vip_potenzial: 'bg-amber-500',
};

// ── Trend-Darstellung ─────────────────────────────────────────────────────────

const TREND_META: Record<TrendDirection, { label: string; icon: React.FC<{ className?: string }>; cls: string }> = {
  steigend:   { label: 'Steigend',   icon: TrendingUp,   cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' },
  stabil:     { label: 'Stabil',     icon: Minus,        cls: 'bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-300' },
  rückläufig: { label: 'Rückläufig', icon: TrendingDown, cls: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300' },
};

// ── Bausteine ─────────────────────────────────────────────────────────────────

function Section({ icon: Icon, title, children }: {
  icon: React.FC<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
        <Icon className="h-5 w-5 text-primary" />
        {title}
      </h2>
      {children}
    </section>
  );
}

function Tile({ icon: Icon, label, value, accent }: {
  icon: React.FC<{ className?: string }>;
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <p className={cn('mt-1 text-xl font-bold tabular-nums', accent)}>{value}</p>
    </div>
  );
}

// ── Manuelle CRM-Badges (rein darstellungsbezogen) ───────────────────────────
const MANUAL_BADGE_CLASS: Record<ManualBadgeKind, string> = {
  vip:       'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
  stammgast: 'bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300',
};
const MANUAL_BADGE_ICON: Record<ManualBadgeKind, React.FC<{ className?: string }>> = {
  vip: Crown, stammgast: Star,
};

/** Badge für ein MANUELL gesetztes Kennzeichen (VIP/Stammgast) — unabhängig vom Segment. */
function ManualCrmBadge({ badge }: { badge: ManualBadge }) {
  const Icon = MANUAL_BADGE_ICON[badge.kind];
  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium',
      MANUAL_BADGE_CLASS[badge.kind],
    )}>
      <Icon className="h-3 w-3" />
      {badge.label}
    </span>
  );
}

/** Read-only-Feld für die CRM-Kurzübersicht (Text, mehrzeilig erlaubt). */
function CrmSummaryField({ icon: Icon, label, value }: {
  icon: React.FC<{ className?: string }>;
  label: string;
  value: string | null;
}) {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm">
        {value && value.trim() !== '' ? value : '—'}
      </p>
    </div>
  );
}

function ScoreComponentBar({ label, value, tier }: { label: string; value: number; tier: CrmScoreTier }) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">{NUM0.format(value)}</span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className={cn('h-full rounded-full', TIER_BAR[tier])} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
    </div>
  );
}

const HISTORY_FILTERS: { id: HistoryFilter; label: string }[] = [
  { id: 'alle',      label: 'Alle' },
  { id: 'besuche',   label: 'Nur Besuche' },
  { id: 'storniert', label: 'Nur Storniert' },
  { id: 'noshow',    label: 'Nur No-Show' },
];

// ── Formular-Bausteine (CRM-Tab) ──────────────────────────────────────────────

function FieldText({ icon: Icon, label, value, onChange, disabled, placeholder, type }: {
  icon?: React.FC<{ className?: string }>;
  label: string;
  value: string | null;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {label}
      </Label>
      <Input
        type={type ?? 'text'}
        value={value ?? ''}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function FieldArea({ icon: Icon, label, value, onChange, disabled, placeholder, rows }: {
  icon?: React.FC<{ className?: string }>;
  label: string;
  value: string | null;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {label}
      </Label>
      <Textarea
        value={value ?? ''}
        placeholder={placeholder}
        disabled={disabled}
        rows={rows ?? 3}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function FieldToggle({ icon: Icon, label, description, checked, onChange, disabled }: {
  icon: React.FC<{ className?: string }>;
  label: string;
  description?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background p-3">
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 text-muted-foreground" />
        <div>
          <div className="text-sm font-medium">{label}</div>
          {description && <div className="text-xs text-muted-foreground">{description}</div>}
        </div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

// ── Komponente ────────────────────────────────────────────────────────────────

export default function GaesteDetailPage() {
  const { guestId } = useParams<{ guestId: string }>();
  const { tenantId } = useTenant();
  const { isAdmin } = usePermissions();
  const { isGuest } = useGuestSession();
  const { toast } = useToast();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<GuestProfile | null>(null);
  const [reservations, setReservations] = useState<GuestReservationDisplay[]>([]);
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>('alle');

  // Manuelles CRM-Profil (guest_crm_profiles): `crmSaved` = zuletzt gespeicherter
  // Stand, `crmForm` = aktueller Formularstand. Differenz = ungespeicherte Änderung.
  const [crmSaved, setCrmSaved] = useState<GuestCrmProfile>(EMPTY_CRM_PROFILE);
  const [crmForm, setCrmForm] = useState<GuestCrmProfile>(EMPTY_CRM_PROFILE);
  const [crmSaving, setCrmSaving] = useState(false);
  // Lesefehler des CRM-Profils. Bei gesetztem Fehler ist Bearbeiten/Speichern
  // gesperrt, damit ein Speichern nicht versehentlich echte Daten mit leeren
  // Defaults überschreibt (das Formular zeigt sonst fälschlich „leer = gespeichert").
  const [crmLoadError, setCrmLoadError] = useState<string | null>(null);

  // Schreibrechte: nur echte Admins, NICHT Gast-Sessions (read-only Links erhalten
  // isAdmin lediglich für Lesezugriffe und dürfen keine CRM-Daten verändern); und
  // niemals bei fehlgeschlagenem CRM-Load.
  const canEditCrm = isAdmin && !isGuest && !crmLoadError;

  const today = useMemo(() => fmtDate(new Date(), 'yyyy-MM-dd'), []);

  const load = useCallback(async () => {
    if (!guestId) return;
    if (!isAdmin || isGuest) { setLoading(false); return; }   // Datenschutz: keine Gäste-Reads für Nicht-Admins / Gast-Sessions
    setLoading(true);
    setCrmLoadError(null);
    // Beim Gastwechsel (gleiche Route, neue guestId) zuerst den alten CRM-Stand
    // verwerfen — sonst zeigt der Header/die Übersicht kurzzeitig (oder bei einem
    // CRM-Lesefehler dauerhaft) die manuellen Daten des VORHERIGEN Gastes an.
    setCrmSaved(EMPTY_CRM_PROFILE);
    setCrmForm(EMPTY_CRM_PROFILE);
    const [p, recs] = await Promise.all([
      fetchGuestById(tenantId, guestId),
      fetchGuestReservations(tenantId, guestId),
    ]);
    setProfile(p);
    setReservations(recs);

    // CRM-Profil separat laden: ein echter Lesefehler darf NICHT als „leeres Profil"
    // interpretiert werden — sonst würde ein anschliessendes Speichern bestehende
    // manuelle Daten mit Defaults überschreiben. `fetchGuestCrmProfile` liefert null
    // (= noch kein Profil), wirft aber bei echten Lesefehlern.
    try {
      const crm = await fetchGuestCrmProfile(tenantId, guestId);
      const crmProfile = crm ?? EMPTY_CRM_PROFILE;
      setCrmSaved(crmProfile);
      setCrmForm(crmProfile);
    } catch (e) {
      // Lesefehler: keine stillen Defaults UND keine Altdaten anzeigen.
      setCrmSaved(EMPTY_CRM_PROFILE);
      setCrmForm(EMPTY_CRM_PROFILE);
      setCrmLoadError(e instanceof Error ? e.message : 'CRM-Profil konnte nicht geladen werden.');
    }
    setLoading(false);
  }, [tenantId, guestId, isAdmin, isGuest]);

  useEffect(() => { void load(); }, [load]);

  const crmDirty = useMemo(() => isCrmProfileDirty(crmForm, crmSaved), [crmForm, crmSaved]);
  // Manuelle Badges aus dem GESPEICHERTEN Stand (nicht aus ungespeicherten Formularänderungen).
  const manualBadges = useMemo(() => manualCrmBadges(crmSaved), [crmSaved]);

  const setCrmField = useCallback(
    <K extends keyof GuestCrmProfile>(key: K, value: GuestCrmProfile[K]) =>
      setCrmForm(prev => ({ ...prev, [key]: value })),
    [],
  );

  const handleSaveCrm = useCallback(async () => {
    if (!guestId || !canEditCrm) return;
    setCrmSaving(true);
    try {
      const saved = await upsertGuestCrmProfile(tenantId, guestId, crmForm);
      setCrmSaved(saved);
      setCrmForm(saved);
      toast({ title: 'CRM-Profil gespeichert' });
    } catch (e) {
      toast({
        title: 'Speichern fehlgeschlagen',
        description: e instanceof Error ? e.message : 'Unbekannter Fehler',
        variant: 'destructive',
      });
    } finally {
      setCrmSaving(false);
    }
  }, [tenantId, guestId, canEditCrm, crmForm, toast]);

  const handleResetCrm = useCallback(() => setCrmForm(crmSaved), [crmSaved]);

  const metrics = useMemo(() => guestDetailMetrics(reservations, today), [reservations, today]);
  const simpleStatus = simpleGuestStatus(metrics.visits);
  const preferences = useMemo(() => computeGuestPreferences(reservations), [reservations]);
  const trend = useMemo(() => computeVisitTrend(reservations, today), [reservations, today]);
  const totalPersons = useMemo(() => totalPersonsOnVisits(reservations), [reservations]);
  const crmScore = useMemo(() => computeCrmScore({
    visits: metrics.visits,
    daysSinceLastVisit: metrics.daysSinceLastVisit,
    avgDaysBetweenVisits: metrics.avgDaysBetweenVisits,
    avgPartySize: metrics.avgPartySize,
  }), [metrics]);
  const risk = useMemo(() => {
    if (!profile) return null;
    const lm = guestListMetricsFromDetail(profile, metrics);
    return {
      overdue: isOverdue(lm),
      overdueDays: overdueByDays(lm),
      atRisk: isAtRiskTier(lm, 'stammgast') || isAtRiskTier(lm, 'vip'),
    };
  }, [profile, metrics]);
  const filteredReservations = useMemo(
    () => filterReservationHistory(reservations, historyFilter),
    [reservations, historyFilter],
  );

  if (!isAdmin || isGuest) return <Navigate to="/" replace />;

  const name = profile ? guestDisplayName(profile) : 'Gast';
  const trendMeta = TREND_META[trend.direction];
  const TrendIcon = trendMeta.icon;

  // Export der aktuell gefilterten Reservierungshistorie (CSV + Excel).
  const historyExportTable = () => ({
    filename: `reservierungshistorie-${exportSlug(name)}`,
    sheetName: 'Reservierungen',
    headers: RESERVATION_HISTORY_HEADERS,
    rows: filteredReservations.map(r =>
      reservationHistoryRowToCells(r, s => STATUS_LABEL[s as ReservationStatusNormalized] ?? s),
    ),
  });

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <button
        onClick={() => navigate('/gaeste')}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Zurück zur Gästeliste
      </button>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          Gast wird geladen…
        </div>
      ) : !profile ? (
        <div className="rounded-lg border border-dashed border-border py-16 text-center text-sm text-muted-foreground">
          Dieser Gast wurde nicht gefunden.
        </div>
      ) : (
        <>
          {/* Kopf */}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold">{name}</h1>
              <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                {profile.email && (
                  <span className="inline-flex items-center gap-1"><Mail className="h-3.5 w-3.5" />{profile.email}</span>
                )}
                {profile.mobile && (
                  <span className="inline-flex items-center gap-1"><Phone className="h-3.5 w-3.5" />{profile.mobile}</span>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <SegmentBadge segment={metrics.segment} />
              {manualBadges.map((b) => <ManualCrmBadge key={b.kind} badge={b} />)}
            </div>
          </div>

          <Tabs defaultValue="overview">
            <TabsList className="mb-4">
              <TabsTrigger value="overview" className="gap-1.5">
                <LayoutGrid className="h-4 w-4" />
                Übersicht
              </TabsTrigger>
              <TabsTrigger value="crm" className="gap-1.5">
                <Pencil className="h-4 w-4" />
                CRM
              </TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="space-y-5">
          {/* CRM-Profil (manuell gepflegt) — Kurzüberblick aus guest_crm_profiles */}
          <Section icon={Pencil} title="CRM-Profil">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {manualBadges.length > 0
                  ? manualBadges.map((b) => <ManualCrmBadge key={b.kind} badge={b} />)
                  : <span className="text-sm text-muted-foreground">Keine manuellen Kennzeichen gesetzt.</span>}
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <CrmSummaryField
                  icon={Cake} label="Geburtstag"
                  value={crmSaved.birthday ? crmSaved.birthday.split('-').reverse().join('.') : null}
                />
                <CrmSummaryField icon={Building2} label="Firma" value={crmSaved.company} />
                <CrmSummaryField icon={Wheat} label="Allergien" value={crmSaved.allergies} />
              </div>
              <CrmSummaryField icon={StickyNote} label="Notizen" value={crmSaved.crmNotes} />
            </div>
          </Section>

          {/* CRM-Score */}
          <Section icon={Gauge} title="CRM-Score">
            <div className="grid gap-4 sm:grid-cols-[auto_1fr] sm:items-center">
              <div className="flex items-center gap-4">
                <div className="flex h-24 w-24 flex-col items-center justify-center rounded-full border-4 border-border">
                  <span className="text-3xl font-bold tabular-nums leading-none">{NUM0.format(crmScore.score)}</span>
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">von 100</span>
                </div>
                <span className={cn('inline-flex items-center rounded-md px-2.5 py-1 text-sm font-semibold', TIER_CLASS[crmScore.tier])}>
                  {CRM_SCORE_TIER_LABEL[crmScore.tier]}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                <ScoreComponentBar label="Besuchsanzahl (40%)" value={crmScore.components.visits} tier={crmScore.tier} />
                <ScoreComponentBar label="Aktualität (25%)" value={crmScore.components.recency} tier={crmScore.tier} />
                <ScoreComponentBar label="Regelmässigkeit (20%)" value={crmScore.components.regularity} tier={crmScore.tier} />
                <ScoreComponentBar label="Gruppengrösse (15%)" value={crmScore.components.partySize} tier={crmScore.tier} />
              </div>
            </div>
          </Section>

          {/* Besuchsverhalten */}
          <Section icon={CalendarCheck} title="Besuchsverhalten">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              <div className="rounded-lg border border-border bg-background p-3">
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Segment</div>
                <div className="mt-1"><SegmentBadge segment={metrics.segment} /></div>
              </div>
              <Tile icon={UserCheck} label="Gast-Status" value={simpleStatus ? SIMPLE_STATUS_LABEL[simpleStatus] : 'Ohne Besuch'} />
              <Tile icon={CalendarCheck} label="Total Besuche" value={NUM0.format(metrics.visits)} accent="text-emerald-600 dark:text-emerald-400" />
              <Tile icon={CalendarRange} label="Reservationen total" value={NUM0.format(metrics.totalReservations)} />
              <Tile icon={CalendarRange} label="Erster Besuch" value={fdate(metrics.firstVisit)} />
              <Tile icon={CalendarRange} label="Letzter Besuch" value={fdate(metrics.lastVisit)} />
              <Tile icon={Clock} label="Tage seit letztem Besuch" value={metrics.daysSinceLastVisit === null ? '—' : `${NUM0.format(metrics.daysSinceLastVisit)} Tage`} />
              <Tile icon={Repeat} label="Ø Besuchsintervall" value={metrics.avgDaysBetweenVisits === null ? '—' : `${NUM1.format(metrics.avgDaysBetweenVisits)} Tage`} />
              <Tile icon={UsersIcon} label="Ø Gruppengrösse" value={metrics.avgPartySize === null ? '—' : NUM1.format(metrics.avgPartySize)} />
              <Tile icon={Sigma} label="Total Personen (Besuche)" value={NUM0.format(totalPersons)} />
            </div>
          </Section>

          {/* Präferenzen */}
          <Section icon={MapPin} title="Präferenzen">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Tile icon={MapPin} label="Lieblingsbereich" value={preferences.favoriteArea ?? '—'} />
              <Tile icon={CalendarDays} label="Lieblingswochentag" value={preferences.favoriteWeekday ?? '—'} />
              <Tile icon={CalendarRange} label="Lieblingsmonat" value={preferences.favoriteMonth ?? '—'} />
              <Tile icon={Clock} label="Lieblingszeit" value={preferences.favoriteTime ?? '—'} />
              <Tile icon={Hash} label="Häufigste Gruppengrösse" value={preferences.mostCommonPartySize === null ? '—' : NUM0.format(preferences.mostCommonPartySize)} />
            </div>
          </Section>

          {/* Risiko */}
          <Section icon={AlertTriangle} title="Risiko">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              <Tile icon={Ban} label="No-Shows" value={NUM0.format(metrics.noShowCount)} accent={metrics.noShowCount > 0 ? 'text-orange-600 dark:text-orange-400' : undefined} />
              <Tile icon={CalendarX} label="Stornierungen" value={NUM0.format(metrics.cancelledCount)} accent={metrics.cancelledCount > 0 ? 'text-red-600 dark:text-red-400' : undefined} />
              <div className="rounded-lg border border-border bg-background p-3">
                <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  <Hourglass className="h-3.5 w-3.5" />
                  Überfällig
                </div>
                <p className={cn('mt-1 text-xl font-bold', risk?.overdue ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400')}>
                  {risk?.overdue ? 'Ja' : 'Nein'}
                </p>
              </div>
              <Tile
                icon={Hourglass}
                label="Überfällig seit"
                value={risk?.overdue && risk.overdueDays !== null ? `${NUM0.format(Math.round(risk.overdueDays))} Tage` : '—'}
                accent={risk?.overdue ? 'text-red-600 dark:text-red-400' : undefined}
              />
              <div className="rounded-lg border border-border bg-background p-3">
                <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {risk?.atRisk ? <ShieldAlert className="h-3.5 w-3.5" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                  Gefährdet
                </div>
                <p className={cn('mt-1 text-xl font-bold', risk?.atRisk ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400')}>
                  {risk?.atRisk ? 'Ja' : 'Nein'}
                </p>
              </div>
            </div>
          </Section>

          {/* Trend */}
          <Section icon={TrendingUp} title="Besuchstrend (90 Tage)">
            <div className="flex flex-wrap items-center gap-3">
              <Tile icon={CalendarCheck} label="Letzte 90 Tage" value={NUM0.format(trend.last90)} />
              <Tile icon={CalendarRange} label="Vorherige 90 Tage" value={NUM0.format(trend.previous90)} />
              <span className={cn('inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-semibold', trendMeta.cls)}>
                <TrendIcon className="h-4 w-4" />
                {trendMeta.label}
              </span>
            </div>
          </Section>

          {/* Reservierungshistorie */}
          <Section icon={CalendarRange} title={`Reservierungshistorie (${NUM0.format(filteredReservations.length)})`}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap gap-1.5">
                {HISTORY_FILTERS.map(f => (
                  <button
                    key={f.id}
                    onClick={() => setHistoryFilter(f.id)}
                    className={cn(
                      'rounded-md px-2.5 py-1 text-sm font-medium transition-colors',
                      historyFilter === f.id
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground hover:bg-muted/70',
                    )}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              {filteredReservations.length > 0 && (
                <div className="flex gap-2">
                  <button
                    onClick={() => downloadCsv(historyExportTable())}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
                  >
                    <FileDown className="h-4 w-4" />
                    CSV
                  </button>
                  <button
                    onClick={() => void downloadXlsx(historyExportTable())}
                    className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                  >
                    <FileSpreadsheet className="h-4 w-4" />
                    Excel
                  </button>
                </div>
              )}
            </div>
            {filteredReservations.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
                Keine Reservationen für diese Auswahl.
              </div>
            ) : (
              <div className="max-h-[70vh] overflow-auto rounded-lg border border-border">
                <table className="w-full border-collapse text-sm">
                  <thead className="bg-muted/50 [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-muted [&_th]:border-b [&_th]:border-border">
                    <tr>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Datum</th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Uhrzeit</th>
                      <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Personen</th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Bereich</th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Status</th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Notiz</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredReservations.map(r => {
                      const roomArea = [r.room, r.area].filter(Boolean).join(' · ');
                      const note = [r.note, r.comment].filter(Boolean).join(' — ');
                      return (
                        <tr key={r.id} className="border-t border-border">
                          <td className="px-3 py-2 tabular-nums">{fdate(r.reservationDate)}</td>
                          <td className="px-3 py-2 tabular-nums text-muted-foreground">{r.reservationTime ?? '—'}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{r.partySize ?? '—'}</td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {roomArea ? (
                              <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{roomArea}</span>
                            ) : '—'}
                          </td>
                          <td className="px-3 py-2">
                            <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', STATUS_CLASS[r.statusNormalized])}>
                              {STATUS_LABEL[r.statusNormalized]}
                            </span>
                          </td>
                          <td className="max-w-[24rem] px-3 py-2 text-muted-foreground">
                            {note ? (
                              <span className="inline-flex items-start gap-1"><StickyNote className="mt-0.5 h-3 w-3 flex-shrink-0" />{note}</span>
                            ) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
            </TabsContent>

            {/* ── CRM (manuell gepflegt) ─────────────────────────────────── */}
            <TabsContent value="crm" className="space-y-5">
              <div className="rounded-lg border border-dashed border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                Diese Angaben werden manuell gepflegt und beeinflussen die automatisch
                berechneten Kennzahlen (Segment, CRM-Score, Kampagnen) NICHT.
              </div>

              {crmLoadError && (
                <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                  CRM-Profil konnte nicht geladen werden: {crmLoadError}. Bearbeiten ist
                  deaktiviert, um bestehende Daten nicht versehentlich zu überschreiben.
                </div>
              )}

              {/* Status & Kennzeichen */}
              <Section icon={Crown} title="Status & Kennzeichen">
                <div className="grid gap-2 sm:grid-cols-2">
                  <FieldToggle
                    icon={Crown} label="VIP (manuell)"
                    description="Manuelle Kennzeichnung – unabhängig vom berechneten Segment."
                    checked={crmForm.vipManual}
                    onChange={(v) => setCrmField('vipManual', v)}
                    disabled={!canEditCrm}
                  />
                  <FieldToggle
                    icon={Star} label="Stammgast (manuell)"
                    description="Manuelle Kennzeichnung – unabhängig vom berechneten Segment."
                    checked={crmForm.stammgastManual}
                    onChange={(v) => setCrmField('stammgastManual', v)}
                    disabled={!canEditCrm}
                  />
                  <FieldToggle
                    icon={Building2} label="Firmenkunde"
                    description="Geschäftskunde / Firmenbewirtung."
                    checked={crmForm.companyCustomer}
                    onChange={(v) => setCrmField('companyCustomer', v)}
                    disabled={!canEditCrm}
                  />
                  <FieldToggle
                    icon={BellRing} label="Newsletter"
                    description="Einwilligung in Newsletter / Marketing liegt vor."
                    checked={crmForm.newsletterOptIn}
                    onChange={(v) => setCrmField('newsletterOptIn', v)}
                    disabled={!canEditCrm}
                  />
                  <FieldToggle
                    icon={Lock} label="Sperrliste"
                    description="Gast für Reservationen sperren / besondere Vorsicht."
                    checked={crmForm.blockedGuest}
                    onChange={(v) => setCrmField('blockedGuest', v)}
                    disabled={!canEditCrm}
                  />
                </div>
              </Section>

              {/* Stammdaten */}
              <Section icon={CalendarDays} title="Stammdaten">
                <div className="grid gap-3 sm:grid-cols-3">
                  <FieldText
                    icon={Cake} label="Geburtstag" type="date"
                    value={crmForm.birthday}
                    onChange={(v) => setCrmField('birthday', v || null)}
                    disabled={!canEditCrm}
                  />
                  <FieldText
                    icon={Building2} label="Firma"
                    value={crmForm.company}
                    onChange={(v) => setCrmField('company', v)}
                    disabled={!canEditCrm}
                    placeholder="z. B. Muster AG"
                  />
                  <FieldText
                    icon={Languages} label="Sprache"
                    value={crmForm.language}
                    onChange={(v) => setCrmField('language', v)}
                    disabled={!canEditCrm}
                    placeholder="z. B. DE / FR / EN"
                  />
                </div>
              </Section>

              {/* Präferenzen */}
              <Section icon={MapPin} title="Präferenzen">
                <div className="grid gap-3 sm:grid-cols-2">
                  <FieldText
                    icon={Hash} label="Lieblingsplatz"
                    value={crmForm.favoriteTable}
                    onChange={(v) => setCrmField('favoriteTable', v)}
                    disabled={!canEditCrm}
                    placeholder="z. B. Tisch 12"
                  />
                  <FieldText
                    icon={MapPin} label="Lieblingsbereich"
                    value={crmForm.favoriteArea}
                    onChange={(v) => setCrmField('favoriteArea', v)}
                    disabled={!canEditCrm}
                    placeholder="z. B. Terrasse"
                  />
                  <FieldText
                    icon={Wine} label="Lieblingswein"
                    value={crmForm.favoriteWine}
                    onChange={(v) => setCrmField('favoriteWine', v)}
                    disabled={!canEditCrm}
                  />
                  <FieldText
                    icon={Utensils} label="Lieblingsgericht"
                    value={crmForm.favoriteDish}
                    onChange={(v) => setCrmField('favoriteDish', v)}
                    disabled={!canEditCrm}
                  />
                </div>
              </Section>

              {/* Allergien & Unverträglichkeiten */}
              <Section icon={Wheat} title="Allergien & Unverträglichkeiten">
                <div className="grid gap-3 sm:grid-cols-2">
                  <FieldArea
                    icon={Wheat} label="Allergien"
                    value={crmForm.allergies}
                    onChange={(v) => setCrmField('allergies', v)}
                    disabled={!canEditCrm}
                    placeholder="z. B. Nüsse, Laktose"
                  />
                  <FieldArea
                    icon={Utensils} label="Unverträglichkeiten"
                    value={crmForm.dietaryNotes}
                    onChange={(v) => setCrmField('dietaryNotes', v)}
                    disabled={!canEditCrm}
                    placeholder="z. B. vegetarisch, glutenfrei"
                  />
                </div>
              </Section>

              {/* Notizen */}
              <Section icon={StickyNote} title="CRM-Notizen">
                <FieldArea
                  label="Interne Notizen"
                  value={crmForm.crmNotes}
                  onChange={(v) => setCrmField('crmNotes', v)}
                  disabled={!canEditCrm}
                  rows={5}
                  placeholder="Interne Notizen zum Gast …"
                />
              </Section>

              {/* Aktionen */}
              {canEditCrm ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={handleSaveCrm} disabled={crmSaving || !crmDirty}>
                    {crmSaving
                      ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      : <Save className="mr-2 h-4 w-4" />}
                    Speichern
                  </Button>
                  <Button variant="outline" onClick={handleResetCrm} disabled={crmSaving || !crmDirty}>
                    <RotateCcw className="mr-2 h-4 w-4" />
                    Änderungen verwerfen
                  </Button>
                  {crmDirty && (
                    <span className="text-xs text-muted-foreground">Es gibt ungespeicherte Änderungen.</span>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Nur Administratoren können CRM-Daten bearbeiten.
                </p>
              )}
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
