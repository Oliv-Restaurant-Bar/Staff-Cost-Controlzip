/**
 * Öffentlicher Dienstplan für Mitarbeitende (Link aus der WhatsApp-Nachricht).
 * Kein Login — Zugriff nur über den zufälligen Token (RPC schedule_public_get).
 * Zeigt immer den frisch geladenen Stand; es gibt bewusst keinen lokalen Cache,
 * damit nie ein veralteter Plan angezeigt wird.
 *
 * Optik: je Betrieb eigenes Erscheinungsbild aus dem Logo abgeleitet
 * (Oliv: Schwarz + Salbeigrün, Beaulieu: Tannengrün + Gold), mobile-first.
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useParams } from 'react-router-dom';
import { format, parseISO } from 'date-fns';
import { de } from 'date-fns/locale';
import { CalendarDays, Loader2, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { nextShiftFor } from '@/lib/staff-next-shift';
import { fetchPublicSchedule, type PublicScheduleResponse } from '@/lib/schedule-publish-db';
import {
  SHARE_DEPARTMENT_LABEL,
  type PublicDay,
  type PublicSlot,
  type WeekPayload,
} from '@/lib/schedule-publish-payload';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'invalid' }
  | { kind: 'ok'; data: PublicScheduleResponse; loadedAt: Date };

type ViewMode = 'day' | 'week';

interface Theme {
  name: string;
  logo: string;
  logoClass: string; // Höhe je Logo-Format
  bg: string;
  surface: string;
  ink: string;
  muted: string;
  line: string;
  brand: string; // Auswahl / Hauptakzent
  accent: string; // Dekor-Akzent
  tint: string; // zarte Flächen
  heading: string; // Schriftfamilie Überschriften
}

const THEMES: Record<string, Theme> = {
  oliv: {
    name: 'Oliv Restaurant & Bar',
    logo: '/images/company-logo.png',
    logoClass: 'h-14',
    bg: '#F6F5F0',
    surface: '#FFFFFF',
    ink: '#1B1B19',
    muted: '#6C6F66',
    line: '#E2E4DA',
    brand: '#1B1B19',
    accent: '#8FA687',
    tint: '#EBF0E7',
    heading: "'Jost', 'Avenir Next', 'Century Gothic', sans-serif",
  },
  beaulieu: {
    name: 'Restaurant Beaulieu',
    logo: '/beaulieu-logo-transparent.png',
    logoClass: 'h-[4.5rem]',
    bg: '#F5F2E7',
    surface: '#FFFFFF',
    ink: '#26301A',
    muted: '#6E705E',
    line: '#E4E0CC',
    brand: '#3F5420',
    accent: '#D6A12B',
    tint: '#F1EDD6',
    heading: "'Cormorant Garamond', 'Georgia', serif",
  },
};

const BODY_FONT = "'Jost', 'Avenir Next', 'Century Gothic', sans-serif";
const FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Jost:wght@400;500;600&family=Cormorant+Garamond:wght@500;600;700&display=swap';

const ABSENCE_STYLE: Record<string, { bg: string; fg: string }> = {
  Ferien: { bg: '#E4EFF7', fg: '#285B82' },
  Feiertag: { bg: '#ECE6F5', fg: '#58408A' },
  Frei: { bg: '#ECEBE4', fg: '#65645B' },
  Abwesend: { bg: '#F6E7E3', fg: '#8A392F' },
};
const CHANGED = { bg: '#FFF4DC', fg: '#8A5A00', bar: '#E0A21C' };

const slotText = (s: PublicSlot | null) => (s ? `${s.start} – ${s.end}` : null);

function shifts(d: PublicDay): string[] {
  return [slotText(d.früh), slotText(d.spät)].filter(Boolean) as string[];
}

function absenceOf(d: PublicDay): string | null {
  return d.frühAbsence || d.spätAbsence || null;
}

function hasEntry(d: PublicDay): boolean {
  return shifts(d).length > 0 || !!absenceOf(d);
}

function previousText(d: PublicDay): string {
  const parts = [slotText(d.previousFrüh ?? null), slotText(d.previousSpät ?? null)].filter(Boolean) as string[];
  return parts.length > 0 ? parts.join(' · ') : 'frei';
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : (parts[0][1] ?? '');
  return (first + last).toUpperCase();
}

const personKey = (token: string) => `staff-schedule:person:${token}`;

function readPerson(token: string): string {
  try {
    return localStorage.getItem(personKey(token)) ?? '';
  } catch {
    return '';
  }
}

function writePerson(token: string, name: string) {
  try {
    if (name) localStorage.setItem(personKey(token), name);
    else localStorage.removeItem(personKey(token));
  } catch {
    /* Speicher nicht verfügbar (z. B. privater Modus) — Auswahl gilt dann nur bis zum Neuladen */
  }
}

/** Defekte Wochen überspringen, statt die ganze Seite abstürzen zu lassen. */
function isRenderableWeek(w: PublicScheduleResponse['weeks'][number]): boolean {
  const p = w?.payload as Partial<WeekPayload> | undefined;
  if (!p || typeof p.weekStart !== 'string' || !Array.isArray(p.employees)) return false;
  if (Number.isNaN(parseISO(p.weekStart).getTime())) return false;
  return p.employees.every(e => e && typeof e.name === 'string' && Array.isArray(e.days));
}

const StaffSchedulePage = () => {
  const { token = '' } = useParams<{ token: string }>();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [weekKey, setWeekKey] = useState<string | null>(null);
  const [dayKey, setDayKey] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>('day');
  // Namensfilter: '' = ganze Abteilung. Wird pro Link auf dem Gerät gemerkt.
  const [person, setPersonState] = useState<string>(() => readPerson(token));

  // Schriften + noindex nur für diese Seite laden (kein globaler Eingriff).
  useEffect(() => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = FONTS_HREF;
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.append(link, meta);
    return () => {
      link.remove();
      meta.remove();
    };
  }, []);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const data = await fetchPublicSchedule(token);
      setState(
        data && Array.isArray(data.weeks)
          ? { kind: 'ok', data: { ...data, weeks: data.weeks.filter(isRenderableWeek) }, loadedAt: new Date() }
          : { kind: 'invalid' },
      );
    } catch (e) {
      // Technische Details nicht an anonyme Besucher ausgeben.
      console.error('[staff-schedule] load failed', e);
      setState(prev =>
        prev.kind === 'ok'
          ? prev // letzten erfolgreichen Stand behalten
          : { kind: 'error', message: 'Bitte Verbindung prüfen und es gleich noch einmal versuchen.' },
      );
    } finally {
      setRefreshing(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  const tenant = state.kind === 'ok' ? state.data.tenant : 'oliv';
  const theme = THEMES[tenant] ?? THEMES.oliv;

  useEffect(() => {
    document.title = `Dienstplan – ${theme.name}`;
  }, [theme.name]);

  // Beaulieu-Link: Tab-/Homescreen-Symbol des Betriebs statt des Oliv-Logos.
  useEffect(() => {
    if (tenant !== 'beaulieu') return;
    const replaced = Array.from(document.head.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]'));
    replaced.forEach(l => l.remove());
    const icon = document.createElement('link');
    icon.rel = 'icon';
    icon.type = 'image/png';
    icon.href = '/favicon-beaulieu-32.png?v=2';
    const apple = document.createElement('link');
    apple.rel = 'apple-touch-icon';
    apple.href = '/apple-touch-icon-beaulieu.png?v=2';
    document.head.append(icon, apple);
    return () => {
      icon.remove();
      apple.remove();
      replaced.forEach(l => document.head.append(l));
    };
  }, [tenant]);

  const weeks = useMemo(() => (state.kind === 'ok' ? state.data.weeks : []), [state]);

  // Standard: aktuelle Woche, sonst nächste kommende, sonst letzte.
  useEffect(() => {
    if (weeks.length === 0) return;
    if (weekKey && weeks.some(w => w.week_start === weekKey)) return;
    const today = format(new Date(), 'yyyy-MM-dd');
    const current = weeks.find(w => w.payload.weekStart <= today && today <= w.payload.weekEnd);
    const upcoming = weeks.find(w => w.payload.weekStart > today);
    setWeekKey((current ?? upcoming ?? weeks[weeks.length - 1]).week_start);
  }, [weeks, weekKey]);

  const people = useMemo(() => {
    const names = new Set<string>();
    weeks.forEach(w => w.payload.employees.forEach(e => names.add(e.name)));
    return [...names].sort((a, b) => a.localeCompare(b, 'de'));
  }, [weeks]);

  // Gemerkter Name, der nicht (mehr) im Plan steht, wird ignoriert statt eine leere Seite zu zeigen.
  const activePerson = person && people.includes(person) ? person : '';
  const setPerson = (name: string) => {
    setPersonState(name);
    writePerson(token, name);
  };

  // Aktive Woche in der Wochenleiste sichtbar halten (Leiste scrollt auf dem Handy seitlich).
  useEffect(() => {
    if (!weekKey) return;
    document
      .querySelector(`[data-week="${weekKey}"]`)
      ?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [weekKey, weeks.length]);

  // Nächste Schicht der gewählten Person über alle veröffentlichten Wochen (Minutentakt reicht).
  const nextShift = useMemo(
    () => (activePerson ? nextShiftFor(weeks.map(w => w.payload), activePerson, new Date()) : null),
    [weeks, activePerson],
  );

  const week = weeks.find(w => w.week_start === weekKey) ?? null;
  const payload = week?.payload ?? null;
  const todayKey = format(new Date(), 'yyyy-MM-dd');

  const weekDates = useMemo(() => {
    if (!payload) return [] as Date[];
    const start = parseISO(payload.weekStart);
    return Array.from({ length: 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }, [payload]);

  // Der Tag wird synchron abgeleitet (kein Effekt): so gibt es beim Wochenwechsel
  // keinen Zwischenzustand ohne Tag, der kurz „kein Dienst“ aufblitzen lässt.
  const dayKeyResolved = useMemo(() => {
    const keys = weekDates.map(d => format(d, 'yyyy-MM-dd'));
    if (dayKey && keys.includes(dayKey)) return dayKey;
    return keys.includes(todayKey) ? todayKey : (keys[0] ?? null);
  }, [weekDates, dayKey, todayKey]);

  const changedDays = useMemo(() => {
    const set = new Set<string>();
    payload?.employees.forEach(e => e.days.forEach(d => d.changed && set.add(d.date)));
    return set;
  }, [payload]);

  const dayEntries = useMemo(() => {
    if (!payload || !dayKeyResolved) return { working: [], off: [] as string[] };
    const working: Array<{ name: string; day: PublicDay }> = [];
    const off: string[] = [];
    for (const emp of payload.employees) {
      if (activePerson && emp.name !== activePerson) continue;
      const day = emp.days.find(d => d.date === dayKeyResolved);
      if (day && hasEntry(day)) working.push({ name: emp.name, day });
      else off.push(emp.name);
    }
    return { working, off };
  }, [payload, dayKeyResolved, activePerson]);

  const departmentLabel = state.kind === 'ok' ? SHARE_DEPARTMENT_LABEL[state.data.department] : '';
  const onDutyCount = dayEntries.working.filter(w => shifts(w.day).length > 0).length;

  const rootStyle = {
    background: theme.bg,
    color: theme.ink,
    fontFamily: BODY_FONT,
  } as CSSProperties;
  const headingStyle = { fontFamily: theme.heading } as CSSProperties;

  return (
    <div className="min-h-screen" style={rootStyle}>
      <div
        className={cn(
          'mx-auto px-4 pb-12 sm:px-6 transition-[max-width] duration-200',
          // Tagesansicht bleibt lesbar schmal; die Wochentabelle bekommt auf Desktop Platz für alle 7 Tage.
          state.kind === 'ok' && view === 'week' ? 'max-w-6xl' : 'max-w-3xl',
        )}
      >
        {/* ── Kopf: Logo, Titel, Stand ───────────────────────────────────── */}
        <header className="pt-7 pb-5 text-center">
          <img
            src={theme.logo}
            alt={theme.name}
            className={cn('mx-auto w-auto mix-blend-multiply', theme.logoClass)}
            draggable={false}
          />
          <div className="mx-auto mt-5 h-0.5 w-10 rounded-full" style={{ background: theme.accent }} />
          <h1
            className="mt-4 text-[1.7rem] leading-tight font-semibold tracking-tight"
            style={headingStyle}
          >
            Dienstplan{departmentLabel ? ` ${departmentLabel}` : ''}
          </h1>
          {payload && (
            <p className="mt-1 text-sm" style={{ color: theme.muted }}>
              KW {payload.kw} · {format(parseISO(payload.weekStart), 'd. MMMM', { locale: de })} –{' '}
              {format(parseISO(payload.weekEnd), 'd. MMMM yyyy', { locale: de })}
            </p>
          )}
          {week && (
            <div className="mt-3 flex items-center justify-center gap-2 text-xs" style={{ color: theme.muted }}>
              <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1" style={{ background: theme.tint }}>
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: theme.accent }} />
                Stand {format(parseISO(week.published_at), "d. MMM, HH:mm 'Uhr'", { locale: de })}
              </span>
              <button
                type="button"
                onClick={() => void load()}
                disabled={refreshing}
                aria-label="Aktualisieren"
                className="inline-flex h-7 w-7 items-center justify-center rounded-full border transition-opacity disabled:opacity-60"
                style={{ borderColor: theme.line, background: theme.surface }}
              >
                <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
              </button>
            </div>
          )}
        </header>

        {/* ── Zustände ───────────────────────────────────────────────────── */}
        {state.kind === 'loading' && (
          <div className="flex items-center justify-center gap-2 py-14" style={{ color: theme.muted }}>
            <Loader2 className="h-5 w-5 animate-spin" /> Dienstplan wird geladen…
          </div>
        )}

        {state.kind === 'error' && (
          <Notice theme={theme} title="Der Dienstplan konnte nicht geladen werden.">
            <p>{state.message}</p>
            <button type="button" onClick={() => void load()} className="mt-2 font-medium underline">
              Erneut versuchen
            </button>
          </Notice>
        )}

        {state.kind === 'invalid' && (
          <Notice theme={theme} title="Dieser Link ist nicht (mehr) gültig.">
            <p>Bitte den aktuellen Link in der WhatsApp-Gruppe verwenden oder die Schichtleitung fragen.</p>
          </Notice>
        )}

        {state.kind === 'ok' && weeks.length === 0 && (
          <Notice theme={theme} title="Noch kein Dienstplan veröffentlicht.">
            <p>Sobald ein Plan veröffentlicht wird, erscheint er hier automatisch.</p>
          </Notice>
        )}

        {/* ── Inhalt ─────────────────────────────────────────────────────── */}
        {state.kind === 'ok' && weeks.length > 0 && payload && (
          <>
            {weeks.length > 1 && (
              <div className="mb-4 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {weeks.map(w => {
                  const active = w.week_start === weekKey;
                  return (
                    <button
                      key={w.week_start}
                      data-week={w.week_start}
                      type="button"
                      onClick={() => {
                        // gleichen Wochentag in der neuen Woche behalten
                        const i = Math.max(0, weekDates.findIndex(d => format(d, 'yyyy-MM-dd') === dayKeyResolved));
                        const ws = parseISO(w.payload.weekStart);
                        setDayKey(format(new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + i), 'yyyy-MM-dd'));
                        setWeekKey(w.week_start);
                      }}
                      className="relative shrink-0 rounded-xl border px-3.5 py-1.5 text-center transition-colors"
                      aria-pressed={active}
                      style={
                        active
                          ? { background: theme.brand, borderColor: theme.brand, color: '#fff' }
                          : { background: theme.surface, borderColor: theme.line, color: theme.ink }
                      }
                    >
                      <div className="text-sm font-semibold leading-tight">KW {w.payload.kw}</div>
                      <div className="text-[0.68rem] leading-tight tabular-nums opacity-80">
                        {format(parseISO(w.payload.weekStart), 'd.M.')}–{format(parseISO(w.payload.weekEnd), 'd.M.')}
                      </div>
                      {w.payload.weekStart <= todayKey && todayKey <= w.payload.weekEnd && (
                        <span
                          className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full"
                          style={{ background: theme.accent }}
                          title="Aktuelle Woche"
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Wer ist angezeigt: ganze Abteilung oder nur die eigenen Schichten */}
            {people.length > 1 && (
              <div className="mb-4 flex items-center gap-2">
                <label htmlFor="person-filter" className="shrink-0 text-sm font-medium">
                  Anzeigen für
                </label>
                <select
                  id="person-filter"
                  value={activePerson}
                  onChange={e => setPerson(e.target.value)}
                  className="min-w-0 flex-1 rounded-xl border px-3 py-2 text-sm"
                  style={{ background: theme.surface, borderColor: theme.line, color: theme.ink }}
                >
                  <option value="">Alle – ganze Abteilung</option>
                  {people.map(n => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>
            )}

            {activePerson && (
              <div
                className="mb-4 rounded-2xl border p-3.5"
                style={{ background: theme.tint, borderColor: theme.line }}
                aria-live="polite"
              >
                <div className="text-xs font-medium uppercase tracking-wide" style={{ color: theme.muted }}>
                  Nächste Schicht
                </div>
                {nextShift ? (
                  <button
                    type="button"
                    className="mt-1 flex w-full flex-wrap items-baseline justify-between gap-x-3 text-left"
                    onClick={() => {
                      const target = weeks.find(w => w.payload.weekStart === nextShift.weekStart);
                      if (!target) return;
                      setWeekKey(target.week_start);
                      setDayKey(nextShift.date);
                      setView('day');
                    }}
                  >
                    <span className="text-base font-semibold" style={headingStyle}>
                      {nextShift.isToday ? 'Heute' : format(parseISO(nextShift.date), 'EEEE, d. MMMM', { locale: de })}
                    </span>
                    <span className="text-[1.05rem] font-semibold tabular-nums">{nextShift.times.join(' · ')}</span>
                  </button>
                ) : (
                  <p className="mt-1 text-sm" style={{ color: theme.muted }}>
                    In den veröffentlichten Wochen ist keine weitere Schicht eingetragen.
                  </p>
                )}
              </div>
            )}

            {/* Ansicht umschalten */}
            <div
              className="mb-4 grid grid-cols-2 rounded-xl border p-1 text-sm font-medium"
              style={{ background: theme.surface, borderColor: theme.line }}
              role="tablist"
            >
              {(['day', 'week'] as const).map(v => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={view === v}
                  onClick={() => setView(v)}
                  className="rounded-lg py-2 transition-colors"
                  style={view === v ? { background: theme.tint, color: theme.ink } : { color: theme.muted }}
                >
                  {v === 'day' ? 'Nach Tag' : 'Ganze Woche'}
                </button>
              ))}
            </div>

            <div key={weekKey} className="animate-in fade-in-0 slide-in-from-bottom-1 duration-300">
            {view === 'day' && (
              <>
                {/* Tagesleiste */}
                <div className="grid grid-cols-7 gap-1.5 sm:gap-2.5">
                  {weekDates.map(date => {
                    const key = format(date, 'yyyy-MM-dd');
                    const active = key === dayKeyResolved;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setDayKey(key)}
                        className="relative rounded-xl border py-2 text-center transition-colors"
                        style={
                          active
                            ? { background: theme.brand, borderColor: theme.brand, color: '#fff' }
                            : { background: theme.surface, borderColor: theme.line, color: theme.ink }
                        }
                        aria-pressed={active}
                      >
                        <div className="text-[0.68rem] uppercase tracking-wide opacity-80">
                          {format(date, 'EEEEEE', { locale: de })}
                        </div>
                        <div className="text-base font-semibold tabular-nums">{format(date, 'd')}</div>
                        {key === todayKey && (
                          <span
                            className="absolute left-1/2 -bottom-1 h-1.5 w-1.5 -translate-x-1/2 rounded-full ring-2"
                            style={{ background: theme.accent, ['--tw-ring-color' as string]: theme.bg }}
                            title="Heute"
                          />
                        )}
                        {changedDays.has(key) && (
                          <span
                            className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full"
                            style={{ background: CHANGED.bar }}
                            title="Geändert"
                          />
                        )}
                      </button>
                    );
                  })}
                </div>

                {dayKeyResolved && (
                  <div className="mt-6 mb-3 flex items-baseline justify-between gap-3">
                    <h2 className="text-xl font-semibold" style={headingStyle}>
                      {format(parseISO(dayKeyResolved), 'EEEE, d. MMMM', { locale: de })}
                    </h2>
                    <span className="text-sm" style={{ color: theme.muted }}>
                      {onDutyCount} im Dienst
                    </span>
                  </div>
                )}

                <ul className="space-y-2.5">
                  {dayEntries.working.length === 0 && (
                    <li
                      className="flex items-center gap-3 rounded-2xl border p-4 text-sm"
                      style={{ background: theme.surface, borderColor: theme.line, color: theme.muted }}
                    >
                      <CalendarDays className="h-5 w-5" /> Für diesen Tag ist kein Dienst eingetragen.
                    </li>
                  )}
                  {dayEntries.working.map(({ name, day }, idx) => {
                    const abs = absenceOf(day);
                    const absStyle = abs ? (ABSENCE_STYLE[abs] ?? ABSENCE_STYLE.Abwesend) : null;
                    return (
                      <li
                        key={`${idx}-${name}`}
                        className="flex items-center gap-3.5 rounded-2xl border p-3.5"
                        style={{
                          background: day.changed ? CHANGED.bg : theme.surface,
                          borderColor: day.changed ? CHANGED.bar : theme.line,
                        }}
                      >
                        <span
                          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
                          style={{ background: theme.tint, color: theme.brand }}
                          aria-hidden
                        >
                          {initials(name)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{name}</div>
                          {day.changed && (
                            <div className="text-xs" style={{ color: CHANGED.fg }}>
                              Geändert · vorher {previousText(day)}
                            </div>
                          )}
                        </div>
                        <div className="text-right">
                          {shifts(day).map(t => (
                            <div key={t} className="text-[1.05rem] font-semibold tabular-nums leading-snug">
                              {t}
                            </div>
                          ))}
                          {abs && absStyle && (
                            <span
                              className="mt-0.5 inline-block rounded-full px-2.5 py-0.5 text-xs font-medium"
                              style={{ background: absStyle.bg, color: absStyle.fg }}
                            >
                              {abs}
                            </span>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>

                {dayEntries.off.length > 0 && (
                  <p className="mt-4 text-sm leading-relaxed" style={{ color: theme.muted }}>
                    <span className="font-medium">Kein Dienst:</span> {dayEntries.off.join(', ')}
                  </p>
                )}
              </>
            )}

            {view === 'week' && (
              <>
              <p className="mb-2 text-center text-xs md:hidden" style={{ color: theme.muted }}>
                Seitlich wischen, um alle Tage zu sehen →
              </p>
              <div
                className="overflow-x-auto rounded-2xl border"
                style={{ background: theme.surface, borderColor: theme.line }}
              >
                <table className="w-full min-w-[640px] border-collapse text-[13px] sm:min-w-[760px] sm:text-sm">
                  <thead>
                    <tr style={{ background: theme.tint }}>
                      <th
                        className="sticky left-0 z-10 px-2.5 py-2.5 text-left font-semibold sm:px-3.5"
                        style={{ background: theme.tint }}
                      >
                        Name
                      </th>
                      {weekDates.map(date => {
                        const key = format(date, 'yyyy-MM-dd');
                        return (
                          <th
                            key={key}
                            className="whitespace-nowrap px-2 py-2.5 text-left font-semibold sm:px-3"
                            style={key === todayKey ? { boxShadow: `inset 0 -3px 0 ${theme.accent}` } : undefined}
                          >
                            {format(date, 'EEEEEE d.', { locale: de })}
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {payload.employees.filter(e => !activePerson || e.name === activePerson).map((emp, idx) => (
                      <tr key={`${idx}-${emp.name}`} className="border-t" style={{ borderColor: theme.line }}>
                        <td
                          className="sticky left-0 z-10 w-[6.75rem] min-w-[6.75rem] px-2.5 py-2.5 font-medium leading-tight sm:w-auto sm:min-w-0 sm:whitespace-nowrap sm:px-3.5"
                          style={{ background: theme.surface }}
                        >
                          {emp.name}
                        </td>
                        {emp.days.map(d => {
                          const abs = absenceOf(d);
                          const text = shifts(d).map(t => t.replace(' – ', '–')).join(' · ') || abs;
                          return (
                            <td
                              key={d.date}
                              className="whitespace-nowrap px-2 py-2.5 tabular-nums sm:px-3"
                              style={d.changed ? { background: CHANGED.bg, color: CHANGED.fg } : undefined}
                            >
                              {text ?? <span style={{ color: theme.muted }}>–</span>}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </>
            )}

            {activePerson && !payload.employees.some(e => e.name === activePerson) && (
              <p className="mt-4 text-sm" style={{ color: theme.muted }}>
                {activePerson} ist in dieser Woche nicht im Dienstplan eingetragen.
              </p>
            )}

            </div>

            {changedDays.size > 0 && (
              <p
                className="mt-4 flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm"
                style={{ background: CHANGED.bg, color: CHANGED.fg }}
              >
                <span className="h-2 w-2 rounded-full" style={{ background: CHANGED.bar }} />
                Hervorgehobene Einträge wurden seit der letzten Version geändert.
              </p>
            )}
          </>
        )}

        <footer className="mt-10 text-center text-xs" style={{ color: theme.muted }}>
          <div className="mx-auto mb-3 h-px w-10" style={{ background: theme.line }} />
          {theme.name}
          {state.kind === 'ok' && <> · geladen um {format(state.loadedAt, 'HH:mm')} Uhr</>}
        </footer>
      </div>
    </div>
  );
};

const Notice = ({ theme, title, children }: { theme: Theme; title: string; children: React.ReactNode }) => (
  <div
    className="rounded-2xl border p-5 text-sm leading-relaxed"
    style={{ background: theme.surface, borderColor: theme.line, color: theme.muted }}
  >
    <p className="mb-1 text-base font-semibold" style={{ color: theme.ink }}>
      {title}
    </p>
    {children}
  </div>
);

export default StaffSchedulePage;
