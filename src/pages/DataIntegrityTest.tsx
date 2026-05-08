import { useEffect, useState } from 'react';
import { kvGet } from '@/lib/supabase-kv';
import { useTenant } from '@/contexts/TenantContext';

interface DayEntry {
  actualRevenue?: number;
  previousYearRevenue?: number;
  plannedRevenue?: number;
  actualFood?: number;
  actualBeverage?: number;
  actualLaborCost?: number;
  [k: string]: unknown;
}

function fmt(n: number | undefined) {
  if (!n || n === 0) return '—';
  return n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function DataIntegrityTest() {
  const { tenantKey } = useTenant();
  const [report, setReport] = useState<string>('Lade …');
  const [raw, setRaw] = useState<Record<string, DayEntry>>({});

  useEffect(() => {
    async function run() {
      const storageKey = tenantKey('dailyBudgets');
      const lines: string[] = [];
      lines.push(`=== DATENINTEGRITÄTS-TEST (${new Date().toISOString()}) ===\n`);
      lines.push(`KV-Schlüssel: ${storageKey}\n`);

      // 1. localStorage lesen
      let local: Record<string, DayEntry> = {};
      try {
        const raw = localStorage.getItem(storageKey);
        local = raw ? JSON.parse(raw) : {};
      } catch { /* */ }

      // 2. Supabase KV lesen
      let remote: Record<string, DayEntry> = {};
      try {
        const kv = await kvGet(storageKey);
        if (kv && typeof kv === 'object' && !Array.isArray(kv)) {
          remote = kv as Record<string, DayEntry>;
        }
      } catch (e) {
        lines.push(`FEHLER beim Lesen von Supabase KV: ${e}\n`);
      }

      lines.push(`\nlocalStorage: ${Object.keys(local).length} Tage`);
      lines.push(`Supabase KV:  ${Object.keys(remote).length} Tage\n`);

      // Merge für Vollständigkeit
      const allDays = new Set([...Object.keys(local), ...Object.keys(remote)]);
      lines.push(`Gesamtbestand nach Merge: ${allDays.size} Tage\n`);

      // 3. April 2026 analysieren
      lines.push('\n────────────────────────────────────────────────────────');
      lines.push('APRIL 2026 — TAGESUMSÄTZE (Ist/Brutto)');
      lines.push('────────────────────────────────────────────────────────');
      lines.push('Tag          | Supabase KV  | localStorage | Übereinstim.');

      const aprilDays: string[] = [];
      for (let d = 1; d <= 30; d++) {
        aprilDays.push(`2026-04-${String(d).padStart(2, '0')}`);
      }

      let aprilTotalKV = 0;
      let aprilTotalLocal = 0;
      let missingKV = 0;
      let missingLocal = 0;
      let mismatches = 0;
      const mergedApril: Record<string, DayEntry> = {};

      for (const day of aprilDays) {
        const kvVal  = remote[day]?.actualRevenue ?? 0;
        const locVal = local[day]?.actualRevenue ?? 0;
        aprilTotalKV    += kvVal;
        aprilTotalLocal += locVal;
        if (kvVal === 0)  missingKV++;
        if (locVal === 0) missingLocal++;
        const match = Math.abs(kvVal - locVal) < 0.01 ? '✓' : `≠ (diff: ${(kvVal - locVal).toFixed(2)})`;
        if (match !== '✓') mismatches++;
        const label = day.slice(8);
        lines.push(`${day}   | ${fmt(kvVal).padStart(12)} | ${fmt(locVal).padStart(12)} | ${match}`);
        mergedApril[day] = { ...local[day], ...remote[day] };
      }

      lines.push('────────────────────────────────────────────────────────');
      lines.push(`SUMME April  | ${fmt(aprilTotalKV).padStart(12)} | ${fmt(aprilTotalLocal).padStart(12)} |`);
      lines.push(`\nFehlende Tage (=0): KV=${missingKV}/30, localStorage=${missingLocal}/30`);
      lines.push(`Abweichungen KV↔Local: ${mismatches}/30`);

      // 4. VJ April 2025
      lines.push('\n────────────────────────────────────────────────────────');
      lines.push('APRIL 2025 — VORJAHRESDATEN (aus dailyBudgets-Blob)');
      lines.push('────────────────────────────────────────────────────────');
      let vjTotal = 0;
      let vjMissing = 0;
      for (let d = 1; d <= 30; d++) {
        const day = `2025-04-${String(d).padStart(2, '0')}`;
        const kvVal = remote[day]?.actualRevenue ?? 0;
        vjTotal += kvVal;
        if (kvVal === 0) vjMissing++;
      }
      lines.push(`Vorjahr April 2025 Summe (KV): ${fmt(vjTotal)}`);
      lines.push(`Fehlende VJ-Tage: ${vjMissing}/30`);

      // 5. Konsistenzprüfung über weitere Monate 2026
      lines.push('\n────────────────────────────────────────────────────────');
      lines.push('2026 JAHRESÜBERSICHT — MONATSSUMMEN (Supabase KV)');
      lines.push('────────────────────────────────────────────────────────');
      const months2026 = ['01','02','03','04','05','06','07','08','09','10','11','12'];
      for (const m of months2026) {
        let total = 0;
        let days = 0;
        for (const [day, entry] of Object.entries(remote)) {
          if (day.startsWith(`2026-${m}`)) {
            total += entry.actualRevenue ?? 0;
            if ((entry.actualRevenue ?? 0) > 0) days++;
          }
        }
        lines.push(`2026-${m}: CHF ${fmt(total).padStart(14)} | ${days} Tage mit Umsatz`);
      }

      // 6. Inkonsistenz-Erkennung: localStorage hat Daten die KV nicht hat
      const onlyLocal: string[] = [];
      const onlyRemote: string[] = [];
      for (const [day, entry] of Object.entries(local)) {
        const locRev = entry.actualRevenue ?? 0;
        const kvRev  = (remote[day]?.actualRevenue ?? 0);
        if (locRev > 0 && kvRev === 0 && day.startsWith('2026')) {
          onlyLocal.push(`${day}: ${fmt(locRev)}`);
        }
      }
      for (const [day, entry] of Object.entries(remote)) {
        const kvRev  = entry.actualRevenue ?? 0;
        const locRev = (local[day]?.actualRevenue ?? 0);
        if (kvRev > 0 && locRev === 0 && day.startsWith('2026')) {
          onlyRemote.push(`${day}: ${fmt(kvRev)}`);
        }
      }
      lines.push('\n────────────────────────────────────────────────────────');
      lines.push('INKONSISTENZ-BERICHT 2026');
      lines.push('────────────────────────────────────────────────────────');
      lines.push(`Tage nur in localStorage (fehlen in KV): ${onlyLocal.length}`);
      if (onlyLocal.length > 0) onlyLocal.slice(0, 10).forEach(l => lines.push(`  ⚠ ${l}`));
      lines.push(`Tage nur in Supabase KV (fehlen lokal): ${onlyRemote.length}`);
      if (onlyRemote.length > 0) onlyRemote.slice(0, 10).forEach(l => lines.push(`  ℹ ${l}`));

      const result = lines.join('\n');
      setReport(result);
      setRaw(remote);
      console.log('[INTEGRITY-TEST] Full report:\n' + result);
    }
    run();
  }, []);

  return (
    <div style={{ fontFamily: 'monospace', fontSize: 12, padding: 24, background: '#111', color: '#eee', minHeight: '100vh', whiteSpace: 'pre-wrap' }}>
      <h2 style={{ color: '#4ade80', marginBottom: 16 }}>Datenintegritäts-Test</h2>
      {report}
    </div>
  );
}
