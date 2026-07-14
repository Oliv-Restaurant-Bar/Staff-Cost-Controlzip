/**
 * StaffPortalSettingsPanel
 * ────────────────────────
 * Admin UI for central Mitarbeiterportal configuration.
 * Uses iOS-style Switch rows with label + description.
 * Auto-saves on every toggle (debounced, 600ms).
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  MessageCircle, Eye, Bell, Shield, Zap, Check, Loader2,
  ChevronDown, ChevronUp,
} from 'lucide-react';
import {
  StaffPortalSettings,
  DEFAULT_STAFF_PORTAL_SETTINGS,
  loadStaffPortalSettings,
  saveStaffPortalSettings,
} from '@/lib/staff-portal-settings';

// ── Types ─────────────────────────────────────────────────────────────────────

type Section = 'communication' | 'visibility' | 'notifications' | 'security' | 'future';

interface ToggleRowProps {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  badgeLabel?: string;
}

// ── Components ────────────────────────────────────────────────────────────────

function ToggleRow({ label, description, checked, onChange, disabled, badgeLabel }: ToggleRowProps) {
  return (
    <div className={cn(
      'flex items-start justify-between gap-4 py-3.5 px-4',
      disabled && 'opacity-50',
    )}>
      <div className="flex-1 min-w-0 pr-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-foreground leading-snug">{label}</span>
          {badgeLabel && (
            <Badge variant="outline" className="text-[9px] font-bold uppercase tracking-wide border-muted-foreground/30 text-muted-foreground/60 py-0 px-1.5">
              {badgeLabel}
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground/70 mt-0.5 leading-snug">{description}</p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={disabled ? undefined : onChange}
        disabled={disabled}
        className="shrink-0 mt-0.5 data-[state=checked]:bg-emerald-600"
      />
    </div>
  );
}

interface SectionCardProps {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
  activeCount?: number;
  totalCount?: number;
}

function SectionCard({ icon, title, subtitle, defaultOpen = true, children, activeCount, totalCount }: SectionCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-2xl border border-border/60 bg-card overflow-hidden shadow-sm">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-muted/30 transition-colors"
      >
        <div className="h-8 w-8 rounded-xl bg-muted/60 flex items-center justify-center shrink-0">
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground">{title}</p>
          <p className="text-xs text-muted-foreground/70">{subtitle}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {totalCount !== undefined && (
            <span className="text-[11px] text-muted-foreground/50 tabular-nums">
              {activeCount}/{totalCount}
            </span>
          )}
          {open
            ? <ChevronUp className="h-4 w-4 text-muted-foreground/40" />
            : <ChevronDown className="h-4 w-4 text-muted-foreground/40" />}
        </div>
      </button>
      {open && (
        <div className="border-t border-border/30 divide-y divide-border/20">
          {children}
        </div>
      )}
    </div>
  );
}

// ── Main Panel ────────────────────────────────────────────────────────────────

export function StaffPortalSettingsPanel() {
  const [settings, setSettings] = useState<StaffPortalSettings>(DEFAULT_STAFF_PORTAL_SETTINGS);
  const [loading, setLoading]   = useState(true);
  const [saving,  setSaving]    = useState(false);
  const [saved,   setSaved]     = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstLoad = useRef(true);

  useEffect(() => {
    void loadStaffPortalSettings().then(s => {
      setSettings(s);
      setLoading(false);
    });
  }, []);

  const persistSettings = useCallback(async (next: StaffPortalSettings) => {
    setSaving(true);
    setSaved(false);
    try {
      await saveStaffPortalSettings(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch {
      toast.error('Einstellungen konnten nicht gespeichert werden');
    } finally {
      setSaving(false);
    }
  }, []);

  const update = useCallback(<K extends Section>(
    section: K,
    key: keyof StaffPortalSettings[K],
    value: boolean,
  ) => {
    setSettings(prev => {
      const next = {
        ...prev,
        [section]: { ...prev[section], [key]: value },
      };
      // Debounce the save
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void persistSettings(next), 600);
      return next;
    });
  }, [persistSettings]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 px-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Einstellungen laden…</span>
      </div>
    );
  }

  const com = settings.communication;
  const vis = settings.visibility;
  const ntf = settings.notifications;
  const sec = settings.security;
  const fut = settings.future;

  // Count active toggles per section
  const comActive = Object.values(com).filter(Boolean).length;
  const visActive = Object.values(vis).filter(Boolean).length;
  const ntfActive = Object.values(ntf).filter(Boolean).length;
  const secActive = [sec.allowPersonalLinks, sec.allowDepartmentLinks, sec.keepOldSchedulesVisible].filter(Boolean).length;
  const futActive = Object.values(fut).filter(Boolean).length;

  return (
    <div className="space-y-4">
      {/* Save status */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground/60">
          Änderungen werden automatisch gespeichert.
        </p>
        <div className={cn(
          'flex items-center gap-1.5 text-xs font-medium transition-all duration-300',
          saved  ? 'text-emerald-600 opacity-100' : 'opacity-0',
        )}>
          {saving
            ? <Loader2 className="h-3 w-3 animate-spin" />
            : <Check className="h-3 w-3" />}
          {saved ? 'Gespeichert' : ''}
        </div>
      </div>

      {/* ── 1. Kommunikation ─────────────────────────────────────────────── */}
      <SectionCard
        icon={<MessageCircle className="h-4 w-4 text-blue-600" />}
        title="Kommunikation"
        subtitle="Rückmeldungen, Fragen und Wünsche der Mitarbeitenden"
        activeCount={comActive}
        totalCount={Object.keys(com).length}
      >
        <ToggleRow
          label="Rückfragen erlauben"
          description="Mitarbeitende können eine Frage an die Leitung senden."
          checked={com.allowQuestions}
          onChange={v => update('communication', 'allowQuestions', v)}
        />
        <ToggleRow
          label="Wünsche & Hinweise erlauben"
          description="Mitarbeitende können Wünsche oder Hinweise einreichen."
          checked={com.allowRequests}
          onChange={v => update('communication', 'allowRequests', v)}
        />
        <ToggleRow
          label='"Bestätigt"-Button anzeigen'
          description='Mitarbeitende können den Plan mit "Bestätigt" quittieren.'
          checked={com.requireConfirmation}
          onChange={v => update('communication', 'requireConfirmation', v)}
        />
        <ToggleRow
          label='"Gesehen"-Status anzeigen'
          description='Mitarbeitende können den Plan als "Gesehen" markieren.'
          checked={com.enableSeenStatus}
          onChange={v => update('communication', 'enableSeenStatus', v)}
        />
        <ToggleRow
          label="Änderungen hervorheben"
          description='Geänderte Schichten werden mit orangem Rahmen und "Geändert" Badge markiert.'
          checked={com.showChangeHighlights}
          onChange={v => update('communication', 'showChangeHighlights', v)}
        />
        <ToggleRow
          label="Homescreen-Hinweis anzeigen"
          description="Hinweis-Banner, dass der Link zum Startbildschirm hinzugefügt werden kann."
          checked={com.showHomeScreenHint}
          onChange={v => update('communication', 'showHomeScreenHint', v)}
        />
      </SectionCard>

      {/* ── 2. Sichtbarkeit ──────────────────────────────────────────────── */}
      <SectionCard
        icon={<Eye className="h-4 w-4 text-purple-600" />}
        title="Sichtbarkeit"
        subtitle="Welche Tabs, Bereiche und Informationen sichtbar sind"
        activeCount={visActive}
        totalCount={Object.keys(vis).length}
      >
        <ToggleRow
          label="Wochenansicht anzeigen"
          description='Tab "Woche" mit kompaktem Wochen-Grid ist sichtbar.'
          checked={vis.enableWeekView}
          onChange={v => update('visibility', 'enableWeekView', v)}
        />
        <ToggleRow
          label='"Nach Tag"-Ansicht anzeigen'
          description='Tab "Nach Tag" gruppiert Schichten nach Datum.'
          checked={vis.enableDayView}
          onChange={v => update('visibility', 'enableDayView', v)}
        />
        <ToggleRow
          label="Mitarbeitersuche anzeigen"
          description="Suchfeld zum Filtern von Mitarbeitenden in der Abteilungsansicht."
          checked={vis.enableEmployeeSearch}
          onChange={v => update('visibility', 'enableEmployeeSearch', v)}
        />
        <ToggleRow
          label="Freie Tage anzeigen"
          description="Tage ohne Dienst werden in der Listenansicht angezeigt (gedimmt)."
          checked={vis.showFreeDays}
          onChange={v => update('visibility', 'showFreeDays', v)}
        />
        <ToggleRow
          label="Abteilungslabels anzeigen"
          description='Abschnittsüberschriften "Service" und "Küche" in der Mitarbeiterliste.'
          checked={vis.showDepartments}
          onChange={v => update('visibility', 'showDepartments', v)}
        />
        <ToggleRow
          label="Uhrzeiten anzeigen"
          description="Schicht-Zeiten werden als Chips angezeigt (z. B. 10:00–18:00)."
          checked={vis.showHours}
          onChange={v => update('visibility', 'showHours', v)}
        />
      </SectionCard>

      {/* ── 3. Benachrichtigungen ─────────────────────────────────────────── */}
      <SectionCard
        icon={<Bell className="h-4 w-4 text-amber-600" />}
        title="Benachrichtigungen"
        subtitle="Badges, WhatsApp-Links und Push-Vorbereitung"
        defaultOpen={false}
        activeCount={ntfActive}
        totalCount={Object.keys(ntf).length}
      >
        <ToggleRow
          label='Update-Badge "Aktualisiert" anzeigen'
          description='Orange Badge im Header, wenn der Plan geändert wurde.'
          checked={ntf.showUpdateBadges}
          onChange={v => update('notifications', 'showUpdateBadges', v)}
        />
        <ToggleRow
          label="WhatsApp-Teilen vorbereiten"
          description="WhatsApp-Sharing-Button für Dienstplan-Links (noch nicht aktiv)."
          checked={ntf.enableWhatsApp}
          onChange={v => update('notifications', 'enableWhatsApp', v)}
          badgeLabel="Demnächst"
        />
        <ToggleRow
          label="QR-Code für Links"
          description="QR-Code-Generierung für Abteilungs-Links (noch nicht aktiv)."
          checked={ntf.enableQRCode}
          onChange={v => update('notifications', 'enableQRCode', v)}
          badgeLabel="Demnächst"
        />
        <ToggleRow
          label="Push-Infrastruktur vorbereiten"
          description="Service Worker für zukünftige Push-Benachrichtigungen registrieren."
          checked={ntf.enablePushPreparation}
          onChange={v => update('notifications', 'enablePushPreparation', v)}
          badgeLabel="Demnächst"
        />
      </SectionCard>

      {/* ── 4. Sicherheit ────────────────────────────────────────────────── */}
      <SectionCard
        icon={<Shield className="h-4 w-4 text-red-600" />}
        title="Sicherheit"
        subtitle="Link-Typen, Ablauf und Zugriffskontrolle"
        defaultOpen={false}
        activeCount={secActive}
        totalCount={3}
      >
        <ToggleRow
          label="Persönliche Links erlauben"
          description="Admin kann personalisierte Links für einzelne Mitarbeitende erstellen."
          checked={sec.allowPersonalLinks}
          onChange={v => update('security', 'allowPersonalLinks', v)}
        />
        <ToggleRow
          label="Abteilungs-Links erlauben"
          description="Admin kann Links für ganze Abteilungen (Service / Küche / Alle) erstellen."
          checked={sec.allowDepartmentLinks}
          onChange={v => update('security', 'allowDepartmentLinks', v)}
        />
        <ToggleRow
          label="Ältere Pläne zugänglich halten"
          description="Veröffentlichte Links älterer Dienstpläne bleiben aktiv (noch nicht aktiv)."
          checked={sec.keepOldSchedulesVisible}
          onChange={v => update('security', 'keepOldSchedulesVisible', v)}
          badgeLabel="Demnächst"
        />
        <div className="px-4 py-3.5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-foreground">Link-Ablauf (Tage)</p>
              <p className="text-xs text-muted-foreground/70 mt-0.5">0 = Links laufen nie ab.</p>
            </div>
            <input
              type="number"
              min={0}
              max={365}
              value={sec.linkExpiryDays}
              onChange={e => {
                const val = Math.max(0, Math.min(365, parseInt(e.target.value) || 0));
                const next: StaffPortalSettings = {
                  ...settings,
                  security: { ...settings.security, linkExpiryDays: val },
                };
                setSettings(next);
                if (saveTimer.current) clearTimeout(saveTimer.current);
                saveTimer.current = setTimeout(() => void persistSettings(next), 800);
              }}
              className="w-20 h-9 rounded-xl border border-border bg-muted/30 px-3 text-sm text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
        </div>
      </SectionCard>

      {/* ── 5. Zukünftige Features ───────────────────────────────────────── */}
      <SectionCard
        icon={<Zap className="h-4 w-4 text-emerald-600" />}
        title="Zukünftige Features"
        subtitle="Datenmodelle aktivieren — noch keine UI"
        defaultOpen={false}
        activeCount={futActive}
        totalCount={Object.keys(fut).length}
      >
        <ToggleRow
          label="Schichttausch vorbereiten"
          description="SwapRequest-Datenmodell wird in Payloads eingebettet (keine UI)."
          checked={fut.prepareShiftSwap}
          onChange={v => update('future', 'prepareShiftSwap', v)}
          badgeLabel="Beta"
        />
        <ToggleRow
          label="Verfügbarkeiten vorbereiten"
          description="Availability-Datenstruktur für zukünftige Eingabe-UI."
          checked={fut.prepareAvailability}
          onChange={v => update('future', 'prepareAvailability', v)}
          badgeLabel="Beta"
        />
        <ToggleRow
          label="Wunschtage vorbereiten"
          description="WishDays-Datenstruktur für zukünftige Wunschtage-Eingabe."
          checked={fut.prepareWishDays}
          onChange={v => update('future', 'prepareWishDays', v)}
          badgeLabel="Beta"
        />
      </SectionCard>
    </div>
  );
}
