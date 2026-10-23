import { describe, expect, it } from 'vitest';
import {
  buildPublicScheduleLink,
  buildWeekPayload,
  buildWhatsAppMessage,
  buildWhatsAppUrl,
  computeStatus,
  fullyCoveredWeekStarts,
  toPublicAbsence,
  type ShareSourceEmployee,
} from '../schedule-publish-payload';

const MONDAY = new Date(2026, 9, 19); // 19.10.2026 (KW 43)

const employees: ShareSourceEmployee[] = [
  { id: 'a', name: 'Zora', department: 'service' },
  { id: 'b', name: 'Anna', department: 'service' },
  { id: 'c', name: 'Koch', department: 'küche' },
];

describe('buildWeekPayload', () => {
  it('filtert nach Abteilung, sortiert nach Name und enthält 7 Tage', () => {
    const { payload } = buildWeekPayload({
      department: 'service',
      weekStart: MONDAY,
      employees,
      scheduleData: {},
    });
    expect(payload.employees.map(e => e.name)).toEqual(['Anna', 'Zora']);
    expect(payload.employees[0].days).toHaveLength(7);
    expect(payload.weekStart).toBe('2026-10-19');
    expect(payload.weekEnd).toBe('2026-10-25');
    expect(payload.kw).toBe(43);
  });

  it('übernimmt Schichten, ignoriert leere Slots und enthält keine Lohnfelder', () => {
    const { payload } = buildWeekPayload({
      department: 'service',
      weekStart: MONDAY,
      employees,
      scheduleData: {
        'b-2026-10-19': { früh: { start: '10:00', end: '16:00' }, spät: { start: '', end: '' } },
        'b-2026-10-20': { frühAbsence: ' FE ' },
      },
    });
    const anna = payload.employees.find(e => e.id === 'b')!;
    expect(anna.days[0].früh).toEqual({ start: '10:00', end: '16:00' });
    expect(anna.days[0].spät).toBeNull();
    expect(anna.days[1].frühAbsence).toBe('Ferien');
    expect(JSON.stringify(payload)).not.toMatch(/wage|lohn|hourly/i);
  });

  it('markiert nur geänderte Tage gegenüber der letzten Veröffentlichung', () => {
    const first = buildWeekPayload({
      department: 'service',
      weekStart: MONDAY,
      employees,
      scheduleData: { 'b-2026-10-19': { früh: { start: '10:00', end: '16:00' } } },
    });
    expect(first.changedDays).toBe(0);

    const second = buildWeekPayload({
      department: 'service',
      weekStart: MONDAY,
      employees,
      scheduleData: { 'b-2026-10-19': { früh: { start: '11:00', end: '17:00' } } },
      previous: first.payload,
    });
    expect(second.changedDays).toBe(1);
    expect(second.changedEmployeeNames).toEqual(['Anna']);
    const day = second.payload.employees.find(e => e.id === 'b')!.days[0];
    expect(day.changed).toBe(true);
    expect(day.previousFrüh).toEqual({ start: '10:00', end: '16:00' });
    expect(second.payload.employees.find(e => e.id === 'b')!.days[1].changed).toBeUndefined();
  });

  it('behält Markierungen bei erneutem Veröffentlichen ohne Änderung', () => {
    const first = buildWeekPayload({
      department: 'service',
      weekStart: MONDAY,
      employees,
      scheduleData: { 'b-2026-10-19': { früh: { start: '10:00', end: '16:00' } } },
    });
    const data = { 'b-2026-10-19': { früh: { start: '11:00', end: '17:00' } } };
    const second = buildWeekPayload({
      department: 'service', weekStart: MONDAY, employees, scheduleData: data, previous: first.payload,
    });
    const third = buildWeekPayload({
      department: 'service', weekStart: MONDAY, employees, scheduleData: data, previous: second.payload,
    });
    expect(third.changedDays).toBe(0);
    expect(third.payload.employees.find(e => e.id === 'b')!.days[0].changed).toBe(true);
  });

  it('markiert neu hinzugekommene Mitarbeitende mit Schichten als geändert', () => {
    const first = buildWeekPayload({
      department: 'service', weekStart: MONDAY, employees: employees.slice(0, 2), scheduleData: {},
    });
    const second = buildWeekPayload({
      department: 'service',
      weekStart: MONDAY,
      employees: [...employees.slice(0, 2), { id: 'd', name: 'Neu', department: 'service' }],
      scheduleData: { 'd-2026-10-21': { spät: { start: '17:00', end: '23:00' } } },
      previous: first.payload,
    });
    expect(second.changedEmployeeNames).toEqual(['Neu']);
    expect(second.changedDays).toBe(1);
  });
});

describe('toPublicAbsence', () => {
  it('veröffentlicht Krankheit/Unfall/Unbekanntes nur als "Abwesend"', () => {
    expect(toPublicAbsence('K')).toBe('Abwesend');
    expect(toPublicAbsence('U')).toBe('Abwesend');
    expect(toPublicAbsence('Arzttermin wegen Rücken')).toBe('Abwesend');
    expect(toPublicAbsence('FT')).toBe('Feiertag');
    expect(toPublicAbsence('F')).toBe('Frei');
    expect(toPublicAbsence('  ')).toBeNull();
    expect(toPublicAbsence(undefined)).toBeNull();
  });
});

describe('computeStatus', () => {
  const build = (start: string) =>
    buildWeekPayload({
      department: 'service',
      weekStart: MONDAY,
      employees,
      scheduleData: { 'b-2026-10-19': { früh: { start, end: '16:00' } } },
    }).payload;

  it('draft ohne Veröffentlichung, published bei Gleichstand, changed bei Abweichung', () => {
    expect(computeStatus(null, build('10:00'))).toBe('draft');
    expect(computeStatus(build('10:00'), build('10:00'))).toBe('published');
    expect(computeStatus(build('10:00'), build('11:00'))).toBe('changed');
  });

  it('ist unabhängig von der Schlüsselreihenfolge nach einem DB-Roundtrip (jsonb)', () => {
    const current = build('10:00');
    // jsonb liefert Objektschlüssel in anderer Reihenfolge zurück: {end, start}
    const fromDb = JSON.parse(
      JSON.stringify(current).replace(/\{"start":"(\d\d:\d\d)","end":"(\d\d:\d\d)"\}/g, '{"end":"$2","start":"$1"}'),
    );
    expect(JSON.stringify(fromDb)).not.toBe(JSON.stringify(current));
    expect(computeStatus(fromDb, current)).toBe('published');
  });
});

describe('fullyCoveredWeekStarts', () => {
  it('liefert nur Wochen, die komplett im Bereich liegen', () => {
    // Oktober 2026: 1.10. (Do) – 31.10. (Sa) -> vollständige Wochen: 5., 12., 19.
    const days = Array.from({ length: 31 }, (_, i) => new Date(2026, 9, i + 1));
    const starts = fullyCoveredWeekStarts(days).map(d => d.getDate());
    expect(starts).toEqual([5, 12, 19]);
  });

  it('akzeptiert eine einzelne Woche über die Monatsgrenze', () => {
    const days = Array.from({ length: 7 }, (_, i) => new Date(2026, 9, 26 + i)); // 26.10.–1.11.
    expect(fullyCoveredWeekStarts(days)).toHaveLength(1);
  });
});

describe('WhatsApp-Nachricht', () => {
  const link = buildPublicScheduleLink('https://oliv.example.app/', 'tok');

  it('baut den Link ohne doppelten Slash', () => {
    expect(link).toBe('https://oliv.example.app/s/tok');
  });

  it('Erstveröffentlichung einer Woche', () => {
    const msg = buildWhatsAppMessage({
      department: 'service', weeks: [{ kw: 43, weekStart: MONDAY }], isUpdate: false, link,
    });
    expect(msg).toBe(
      'Dienstplan Service KW 43 (19.10.–25.10.2026) ist online:\nhttps://oliv.example.app/s/tok',
    );
  });

  it('Aktualisierung mehrerer Wochen', () => {
    const msg = buildWhatsAppMessage({
      department: 'kueche',
      weeks: [{ kw: 43, weekStart: MONDAY }, { kw: 44, weekStart: new Date(2026, 9, 26) }],
      isUpdate: true,
      link,
    });
    expect(msg.startsWith('Dienstplan Küche KW 43, KW 44 wurde aktualisiert:')).toBe(true);
  });

  it('kodiert die wa.me-URL korrekt', () => {
    const url = buildWhatsAppUrl('Hallo Welt\nhttps://x.y/a?b=1&c=2');
    expect(url).toBe('https://wa.me/?text=Hallo%20Welt%0Ahttps%3A%2F%2Fx.y%2Fa%3Fb%3D1%26c%3D2');
  });
});
