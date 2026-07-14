import { useEffect, useState, useCallback } from 'react';
import { kvGet } from '@/lib/supabase-kv';
import { syncLocalToSupabase, syncSupabaseToLocal } from '@/lib/supabase-kv';
import { useTenant } from '@/contexts/TenantContext';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';

interface DayEntry {
  actualRevenue?: number;
  [k: string]: unknown;
}

interface Report {
  localCount: number;
  kvCount: number;
  diff: number;
  onlyLocal: string[];
  onlyKV: string[];
  kvMonthSums: Record<string, { total: number; days: number }>;
  checkedAt: string;
}

function fmt(n: number | undefined) {
  if (!n || n === 0) return '—';
  return n.toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function StatusBadge({ diff }: { diff: number }) {
  if (diff === 0) return <Badge className="bg-green-600 text-white text-base px-3 py-1">✓ SYNCHRON — Diff = 0</Badge>;
  return <Badge className="bg-red-600 text-white text-base px-3 py-1">⚠ NICHT SYNCHRON — Diff = {diff}</Badge>;
}

export default function DataIntegrityTest() {
  const { tenantKey, tenantId } = useTenant();
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  const addLog = (msg: string) => setLog(prev => [`${new Date().toLocaleTimeString('de-CH')} ${msg}`, ...prev]);

  const runCheck = useCallback(async () => {
    setLoading(true);
    const storageKey = tenantKey('dailyBudgets');

    let local: Record<string, DayEntry> = {};
    try {
      const raw = localStorage.getItem(storageKey);
      local = raw ? JSON.parse(raw) : {};
    } catch { /* */ }

    let remote: Record<string, DayEntry> = {};
    try {
      const kv = await kvGet(storageKey);
      if (kv && typeof kv === 'object' && !Array.isArray(kv)) {
        remote = kv as Record<string, DayEntry>;
      }
    } catch (e) {
      addLog(`❌ KV-Lesefehler: ${e}`);
    }

    // Nur 2026-Tage mit Umsatz-Werten vergleichen (Budget-only-Tage ignorieren)
    const localDays = Object.entries(local)
      .filter(([, e]) => (e.actualRevenue ?? 0) > 0)
      .map(([d]) => d);
    const kvDays = Object.entries(remote)
      .filter(([, e]) => (e.actualRevenue ?? 0) > 0)
      .map(([d]) => d);

    const localSet = new Set(localDays);
    const kvSet = new Set(kvDays);

    const onlyLocal = localDays.filter(d => !kvSet.has(d)).sort();
    const onlyKV = kvDays.filter(d => !localSet.has(d)).sort();

    // Monatssummen aus KV
    const kvMonthSums: Record<string, { total: number; days: number }> = {};
    for (const [day, entry] of Object.entries(remote)) {
      const rev = entry.actualRevenue ?? 0;
      if (rev <= 0) continue;
      const month = day.slice(0, 7);
      if (!kvMonthSums[month]) kvMonthSums[month] = { total: 0, days: 0 };
      kvMonthSums[month].total += rev;
      kvMonthSums[month].days += 1;
    }

    setReport({
      localCount: localDays.length,
      kvCount: kvDays.length,
      diff: onlyLocal.length + onlyKV.length,
      onlyLocal,
      onlyKV,
      kvMonthSums,
      checkedAt: new Date().toLocaleString('de-CH'),
    });
    setLoading(false);
  }, [tenantKey]);

  const forceSync = useCallback(async () => {
    setSyncing(true);
    addLog('▶ Force-Sync gestartet …');
    try {
      await syncLocalToSupabase(['dailyBudgets'], tenantId);
      addLog('✓ localStorage → KV: Sync abgeschlossen');
      await syncSupabaseToLocal(['dailyBudgets'], tenantId);
      addLog('✓ KV → localStorage: Sync abgeschlossen');
      await runCheck();
      toast.success('Force-Sync abgeschlossen — Daten geprüft');
    } catch (e) {
      addLog(`❌ Sync-Fehler: ${e}`);
      toast.error('Force-Sync fehlgeschlagen');
    } finally {
      setSyncing(false);
    }
  }, [tenantId, runCheck]);

  const persistenceTest = useCallback(async () => {
    addLog('▶ Persistenztest: lösche localStorage[dailyBudgets] …');
    const storageKey = tenantKey('dailyBudgets');
    const backup = localStorage.getItem(storageKey);
    localStorage.removeItem(storageKey);
    addLog('✓ localStorage geleert — lade aus KV …');
    try {
      const kv = await kvGet(storageKey);
      if (kv && typeof kv === 'object') {
        const days = Object.entries(kv as Record<string, DayEntry>)
          .filter(([, e]) => (e.actualRevenue ?? 0) > 0).length;
        localStorage.setItem(storageKey, JSON.stringify(kv));
        addLog(`✓ KV liefert ${days} Tage mit Umsatz — localStorage wiederhergestellt`);
        toast.success(`Persistenztest OK: ${days} Tage aus KV geladen`);
      } else {
        addLog('❌ KV leer — kein Backup möglich!');
        if (backup) {
          localStorage.setItem(storageKey, backup);
          addLog('↩ localStorage aus Backup wiederhergestellt');
        }
        toast.error('Persistenztest: KV ist leer!');
      }
    } catch (e) {
      addLog(`❌ Fehler beim Persistenztest: ${e}`);
      if (backup) localStorage.setItem(storageKey, backup);
    }
    await runCheck();
  }, [tenantKey, runCheck]);

  useEffect(() => { runCheck(); }, [runCheck]);

  const months = report
    ? Object.keys(report.kvMonthSums).sort().reverse()
    : [];

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-6 font-mono text-sm">
      <div className="max-w-4xl mx-auto space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-green-400">Datenintegritäts-Test</h1>
            <p className="text-gray-400 text-xs mt-1">Mandant: {tenantId} · {report?.checkedAt ?? '…'}</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={runCheck} disabled={loading}>
              {loading ? '⟳ Prüfe …' : '↻ Neu prüfen'}
            </Button>
            <Button size="sm" onClick={forceSync} disabled={syncing || loading}
              className="bg-blue-700 hover:bg-blue-600">
              {syncing ? '⟳ Sync …' : '⬆ Force Sync'}
            </Button>
            <Button size="sm" variant="outline" onClick={persistenceTest} disabled={syncing || loading}
              className="border-yellow-600 text-yellow-400 hover:bg-yellow-900">
              🔒 Persistenztest
            </Button>
          </div>
        </div>

        {/* Status-Box */}
        {report && (
          <div className="bg-gray-900 border border-gray-700 rounded-lg p-5 space-y-4">
            <div className="flex items-center gap-4">
              <StatusBadge diff={report.diff} />
              <span className="text-gray-400 text-xs">
                Gezählt werden nur Tage mit actualRevenue &gt; 0
              </span>
            </div>

            <div className="grid grid-cols-3 gap-4 text-center">
              <div className="bg-gray-800 rounded p-3">
                <div className="text-2xl font-bold text-blue-400">{report.localCount}</div>
                <div className="text-gray-400 text-xs mt-1">localStorage-Tage</div>
              </div>
              <div className="bg-gray-800 rounded p-3">
                <div className="text-2xl font-bold text-green-400">{report.kvCount}</div>
                <div className="text-gray-400 text-xs mt-1">Supabase KV-Tage</div>
              </div>
              <div className={`rounded p-3 ${report.diff === 0 ? 'bg-green-950' : 'bg-red-950'}`}>
                <div className={`text-2xl font-bold ${report.diff === 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {report.diff}
                </div>
                <div className="text-gray-400 text-xs mt-1">Differenz (Ziel: 0)</div>
              </div>
            </div>

            {/* Nur-localStorage-Tage */}
            {report.onlyLocal.length > 0 && (
              <div className="border border-red-700 rounded p-3">
                <div className="text-red-400 font-bold mb-2">
                  ⚠ {report.onlyLocal.length} Tage nur in localStorage (fehlen in KV):
                </div>
                <div className="text-gray-300 text-xs columns-3">
                  {report.onlyLocal.map(d => <div key={d}>{d}</div>)}
                </div>
                <Button size="sm" className="mt-3 bg-red-700 hover:bg-red-600" onClick={forceSync}>
                  Jetzt nach KV synchronisieren
                </Button>
              </div>
            )}

            {/* Nur-KV-Tage */}
            {report.onlyKV.length > 0 && (
              <div className="border border-yellow-700 rounded p-3">
                <div className="text-yellow-400 font-bold mb-2">
                  ℹ {report.onlyKV.length} Tage nur in Supabase KV (werden nach Reload lokal sichtbar):
                </div>
                <div className="text-gray-300 text-xs columns-3">
                  {report.onlyKV.map(d => <div key={d}>{d}</div>)}
                </div>
              </div>
            )}

            {report.diff === 0 && (
              <div className="bg-green-950 border border-green-700 rounded p-3 text-green-300 text-sm">
                ✓ Alle Umsatztage sind identisch in localStorage und Supabase KV vorhanden.
                Keine produktiven Daten liegen nur im Browser-Cache.
              </div>
            )}
          </div>
        )}

        {/* Monatssummen aus KV */}
        {report && months.length > 0 && (
          <div className="bg-gray-900 border border-gray-700 rounded-lg p-5">
            <h2 className="text-green-400 font-bold mb-3">Supabase KV — Monatssummen (Ist-Umsatz)</h2>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-400 border-b border-gray-700">
                  <th className="text-left py-1">Monat</th>
                  <th className="text-right py-1">Tage</th>
                  <th className="text-right py-1">Umsatz Total</th>
                </tr>
              </thead>
              <tbody>
                {months.map(m => (
                  <tr key={m} className="border-b border-gray-800">
                    <td className="py-1">{m}</td>
                    <td className="text-right">{report.kvMonthSums[m].days}</td>
                    <td className="text-right text-green-300">CHF {fmt(report.kvMonthSums[m].total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Activity Log */}
        {log.length > 0 && (
          <div className="bg-gray-900 border border-gray-700 rounded-lg p-4">
            <h2 className="text-gray-400 font-bold mb-2 text-xs uppercase tracking-wider">Aktivitätslog</h2>
            <div className="space-y-0.5 text-xs text-gray-300 max-h-48 overflow-y-auto">
              {log.map((l, i) => <div key={i}>{l}</div>)}
            </div>
          </div>
        )}

        {/* Erklärung */}
        <div className="text-gray-500 text-xs space-y-1 border-t border-gray-800 pt-4">
          <div><strong className="text-gray-400">Force Sync:</strong> Schreibt alle localStorage-Tage nach Supabase KV (falls Tage fehlen), dann holt KV in localStorage.</div>
          <div><strong className="text-gray-400">Persistenztest:</strong> Löscht localStorage-Eintrag und lädt aus KV neu — simuliert frischen Login / gelöschten Cache.</div>
          <div><strong className="text-gray-400">Fehler-Toast:</strong> Jeder Umsatz-Speichervorgang zeigt ab jetzt eine Fehlermeldung wenn Supabase KV nicht erreichbar ist.</div>
        </div>
      </div>
    </div>
  );
}
