import { useState, useEffect, useCallback } from 'react';
import { useTenant } from '@/contexts/TenantContext';
import { supabase } from '@/integrations/supabase/client';
import { usePermissions } from '@/hooks/usePermissions';
import { Navigate } from 'react-router-dom';
import {
  AlertTriangle, CheckCircle, RefreshCw, Trash2, Archive,
  ShieldAlert, Users, Database, HardDrive, Copy,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from 'sonner';
import { archiveEmployee } from '@/lib/supabase-db';

interface DbEmployee {
  id: string;
  name: string;
  department: string | null;
  employment_type: string | null;
  contract_start: string | null;
  employment_end_date: string | null;
  restaurant_id: string | null;
}

interface IntegrityResult {
  supabaseEmployees: DbEmployee[];
  localStorageEmployees: { id: string; name: string; department?: string }[];
  issues: IntegrityIssue[];
  checkedAt: Date;
}

interface IntegrityIssue {
  severity: 'critical' | 'warning' | 'info';
  category: string;
  message: string;
  employeeId?: string;
  employeeName?: string;
  action?: 'archive' | 'delete-local';
}

const DEMO_IDS = new Set(['1','2','3','4','5','6','7','8','9','10','11','12','13','14','15','16','17','18','19','20','21','22','23','24']);

export default function EmployeeIntegrityPanel() {
  const { isAdmin } = usePermissions();
  const { tenantId } = useTenant();
  const [result, setResult] = useState<IntegrityResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [archiving, setArchiving] = useState<string | null>(null);

  if (!isAdmin) return <Navigate to="/personal" replace />;

  const runCheck = useCallback(async () => {
    setLoading(true);
    try {
      // 1. Supabase-Daten laden (alle, ungefiltert)
      const { data: allEmployees, error } = await supabase
        .from('employees')
        .select('id, name, department, employment_type, contract_start, employment_end_date, restaurant_id')
        .order('name');

      if (error) {
        toast.error(`Supabase-Fehler: ${error.message}`);
        return;
      }

      const dbEmployees: DbEmployee[] = allEmployees ?? [];

      // 2. localStorage-Daten
      const localRaw = localStorage.getItem('schedule-employees');
      const localEmployees: { id: string; name: string; department?: string }[] = localRaw
        ? (() => { try { return JSON.parse(localRaw); } catch { return []; } })()
        : [];

      // Tenant-spezifische localStorage-Keys prüfen
      const tenantLocalRaw = localStorage.getItem(`${tenantId}:schedule-employees`);
      const tenantLocalEmployees: { id: string; name: string }[] = tenantLocalRaw
        ? (() => { try { return JSON.parse(tenantLocalRaw); } catch { return []; } })()
        : [];

      const allLocalEmployees = [
        ...localEmployees,
        ...tenantLocalEmployees.filter(t => !localEmployees.some(l => l.id === t.id)),
      ];

      // 3. Issues sammeln
      const issues: IntegrityIssue[] = [];

      // ── A: Demo-IDs in Supabase ──────────────────────────────────────────
      dbEmployees
        .filter(e => DEMO_IDS.has(e.id))
        .forEach(e => {
          issues.push({
            severity: 'critical',
            category: 'Demo-Mitarbeiter in Supabase',
            message: `"${e.name}" (ID ${e.id}) ist ein hardcodierter Demo-Mitarbeiter und sollte nicht in der Datenbank sein.`,
            employeeId: e.id,
            employeeName: e.name,
            action: 'archive',
          });
        });

      // ── B: Import-IDs in Supabase (imported-*) ───────────────────────────
      dbEmployees
        .filter(e => e.id.startsWith('imported-'))
        .forEach(e => {
          issues.push({
            severity: 'critical',
            category: 'Auto-Import-Mitarbeiter in Supabase',
            message: `"${e.name}" (ID ${e.id}) wurde automatisch durch Import erstellt und nie bestätigt.`,
            employeeId: e.id,
            employeeName: e.name,
            action: 'archive',
          });
        });

      // ── C: Mitarbeiter ohne Abteilung ────────────────────────────────────
      dbEmployees
        .filter(e => !e.department && !e.employment_end_date)
        .forEach(e => {
          issues.push({
            severity: 'warning',
            category: 'Fehlende Abteilung',
            message: `"${e.name}" (ID ${e.id}) hat keine Abteilungszuweisung.`,
            employeeId: e.id,
            employeeName: e.name,
          });
        });

      // ── D: Mitarbeiter ohne Anstellungsart ───────────────────────────────
      dbEmployees
        .filter(e => !e.employment_type && !e.employment_end_date)
        .forEach(e => {
          issues.push({
            severity: 'warning',
            category: 'Fehlende Anstellungsart',
            message: `"${e.name}" (ID ${e.id}) hat keine Anstellungsart.`,
            employeeId: e.id,
            employeeName: e.name,
          });
        });

      // ── E: Tenant-Isolation prüfen ───────────────────────────────────────
      const olivInBeaulieu = dbEmployees.filter(
        e => !e.id.startsWith('b-') && e.restaurant_id === 'beaulieu'
      );
      olivInBeaulieu.forEach(e => {
        issues.push({
          severity: 'critical',
          category: 'Tenant-Isolation verletzt',
          message: `"${e.name}" (ID ${e.id}) hat restaurant_id=beaulieu aber keine b-Präfix-ID.`,
          employeeId: e.id,
          employeeName: e.name,
        });
      });

      const beaulieuInOliv = dbEmployees.filter(
        e => e.id.startsWith('b-') && e.restaurant_id === 'oliv'
      );
      beaulieuInOliv.forEach(e => {
        issues.push({
          severity: 'critical',
          category: 'Tenant-Isolation verletzt',
          message: `"${e.name}" (ID ${e.id}) hat b-Präfix aber restaurant_id=oliv.`,
          employeeId: e.id,
          employeeName: e.name,
        });
      });

      // ── F: Duplikate nach Name ────────────────────────────────────────────
      const nameCount = new Map<string, DbEmployee[]>();
      dbEmployees.forEach(e => {
        const key = e.name.toLowerCase().trim();
        if (!nameCount.has(key)) nameCount.set(key, []);
        nameCount.get(key)!.push(e);
      });
      nameCount.forEach((group, name) => {
        if (group.length > 1) {
          issues.push({
            severity: 'warning',
            category: 'Duplikat nach Name',
            message: `"${name}" erscheint ${group.length}× in Supabase: IDs ${group.map(e => e.id).join(', ')}`,
            employeeName: name,
          });
        }
      });

      // ── G: localStorage enthält Demo-IDs ─────────────────────────────────
      const localDemoIds = allLocalEmployees.filter(e => DEMO_IDS.has(e.id));
      if (localDemoIds.length > 0) {
        issues.push({
          severity: 'warning',
          category: 'Demo-Daten in localStorage',
          message: `localStorage enthält ${localDemoIds.length} Demo-Mitarbeiter (IDs: ${localDemoIds.map(e => e.id).join(', ')}). Werden beim nächsten Load automatisch bereinigt.`,
          action: 'delete-local',
        });
      }

      // ── H: localStorage enthält imported-* ───────────────────────────────
      const localImported = allLocalEmployees.filter(e => e.id.startsWith('imported-'));
      if (localImported.length > 0) {
        issues.push({
          severity: 'warning',
          category: 'Auto-Import-Daten in localStorage',
          message: `localStorage enthält ${localImported.length} nicht bestätigte Import-Mitarbeiter (${localImported.map(e => e.name).join(', ')}).`,
          action: 'delete-local',
        });
      }

      // ── I: Nur in localStorage, nicht in Supabase ────────────────────────
      const supabaseIds = new Set(dbEmployees.map(e => e.id));
      const onlyLocal = allLocalEmployees.filter(
        e => !supabaseIds.has(e.id) && !DEMO_IDS.has(e.id) && !e.id.startsWith('imported-')
      );
      onlyLocal.forEach(e => {
        issues.push({
          severity: 'warning',
          category: 'Nur in localStorage',
          message: `"${e.name}" (ID ${e.id}) ist in localStorage aber nicht in Supabase — möglicherweise nie gespeichert.`,
          employeeId: e.id,
          employeeName: e.name,
        });
      });

      setResult({
        supabaseEmployees: dbEmployees,
        localStorageEmployees: allLocalEmployees,
        issues,
        checkedAt: new Date(),
      });
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    runCheck();
  }, [runCheck]);

  const handleArchive = async (employeeId: string, employeeName: string) => {
    setArchiving(employeeId);
    const ok = await archiveEmployee(employeeId);
    if (ok) {
      toast.success(`"${employeeName}" archiviert`);
      runCheck();
    } else {
      toast.error(`Archivieren fehlgeschlagen für "${employeeName}"`);
    }
    setArchiving(null);
  };

  const handleCleanLocalStorage = () => {
    const keys = ['schedule-employees', `${tenantId}:schedule-employees`];
    keys.forEach(key => {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      try {
        const employees: { id: string }[] = JSON.parse(raw);
        const cleaned = employees.filter(
          e => !DEMO_IDS.has(e.id) && !e.id.startsWith('imported-')
        );
        if (cleaned.length !== employees.length) {
          localStorage.setItem(key, JSON.stringify(cleaned));
        }
      } catch { /* ignore */ }
    });
    toast.success('localStorage bereinigt');
    runCheck();
  };

  const criticalCount = result?.issues.filter(i => i.severity === 'critical').length ?? 0;
  const warningCount  = result?.issues.filter(i => i.severity === 'warning').length  ?? 0;

  const severityColor = (s: IntegrityIssue['severity']) =>
    s === 'critical' ? 'destructive' : s === 'warning' ? 'secondary' : 'outline';

  const severityIcon = (s: IntegrityIssue['severity']) =>
    s === 'critical' ? <ShieldAlert className="h-4 w-4 text-red-500" /> :
    s === 'warning'  ? <AlertTriangle className="h-4 w-4 text-yellow-500" /> :
                       <CheckCircle className="h-4 w-4 text-green-500" />;

  return (
    <div className="container mx-auto py-6 px-4 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShieldAlert className="h-6 w-6 text-primary" />
            Datenintegrität — Mitarbeiter
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Admin-Diagnosepanel für Mitarbeiterdaten-Konsistenz
          </p>
        </div>
        <Button onClick={runCheck} disabled={loading} variant="outline" size="sm">
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
          Prüfung neu starten
        </Button>
      </div>

      {/* Übersicht */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <Database className="h-5 w-5 text-blue-500" />
              <div>
                <p className="text-xs text-muted-foreground">In Supabase</p>
                <p className="text-2xl font-bold">{result?.supabaseEmployees.length ?? '—'}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <HardDrive className="h-5 w-5 text-purple-500" />
              <div>
                <p className="text-xs text-muted-foreground">In localStorage</p>
                <p className="text-2xl font-bold">{result?.localStorageEmployees.length ?? '—'}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-red-500" />
              <div>
                <p className="text-xs text-muted-foreground">Kritisch</p>
                <p className="text-2xl font-bold text-red-600">{criticalCount}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-yellow-500" />
              <div>
                <p className="text-xs text-muted-foreground">Warnungen</p>
                <p className="text-2xl font-bold text-yellow-600">{warningCount}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {loading && (
        <div className="text-center py-12 text-muted-foreground">
          <RefreshCw className="h-8 w-8 animate-spin mx-auto mb-3 text-primary" />
          Prüfung läuft…
        </div>
      )}

      {result && !loading && (
        <>
          {/* Keine Probleme */}
          {result.issues.length === 0 && (
            <Card className="border-green-200 bg-green-50">
              <CardContent className="pt-6 flex items-center gap-3">
                <CheckCircle className="h-8 w-8 text-green-600" />
                <div>
                  <p className="font-semibold text-green-800">Keine Probleme gefunden</p>
                  <p className="text-sm text-green-700">
                    Alle {result.supabaseEmployees.length} Mitarbeiter in Supabase sind konsistent.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Issues-Liste */}
          {result.issues.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4" />
                  {result.issues.length} Problem{result.issues.length !== 1 ? 'e' : ''} gefunden
                </CardTitle>
                <CardDescription>
                  Geprüft um {result.checkedAt.toLocaleTimeString('de-CH')}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex gap-2 mb-4 flex-wrap">
                  {result.issues.some(i => i.action === 'delete-local') && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-yellow-300 text-yellow-700"
                      onClick={handleCleanLocalStorage}
                    >
                      <Trash2 className="h-4 w-4 mr-1" />
                      localStorage bereinigen
                    </Button>
                  )}
                </div>
                <ScrollArea className="max-h-[500px]">
                  <div className="space-y-3">
                    {result.issues.map((issue, idx) => (
                      <div
                        key={idx}
                        className={`flex items-start gap-3 p-3 rounded-md border ${
                          issue.severity === 'critical'
                            ? 'border-red-200 bg-red-50'
                            : issue.severity === 'warning'
                            ? 'border-yellow-200 bg-yellow-50'
                            : 'border-gray-200 bg-gray-50'
                        }`}
                      >
                        <div className="mt-0.5 flex-shrink-0">{severityIcon(issue.severity)}</div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-0.5">
                            {issue.category}
                          </p>
                          <p className="text-sm">{issue.message}</p>
                        </div>
                        {issue.action === 'archive' && issue.employeeId && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="flex-shrink-0 text-xs border-red-300 text-red-700 hover:bg-red-50"
                            disabled={archiving === issue.employeeId}
                            onClick={() => handleArchive(issue.employeeId!, issue.employeeName!)}
                          >
                            <Archive className="h-3 w-3 mr-1" />
                            {archiving === issue.employeeId ? 'Archiviere…' : 'Archivieren'}
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          )}

          {/* Supabase-Mitarbeiterliste */}
          <Card className="mt-4">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Users className="h-4 w-4" />
                Supabase-Mitarbeiterliste ({result.supabaseEmployees.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ScrollArea className="max-h-[400px]">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground border-b">
                      <th className="pb-2 pr-4">ID</th>
                      <th className="pb-2 pr-4">Name</th>
                      <th className="pb-2 pr-4">Abteilung</th>
                      <th className="pb-2 pr-4">Tenant (DB)</th>
                      <th className="pb-2">Austritt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.supabaseEmployees.map(emp => {
                      const isDemo = DEMO_IDS.has(emp.id);
                      const isImported = emp.id.startsWith('imported-');
                      const isArchived = !!emp.employment_end_date;
                      return (
                        <tr
                          key={emp.id}
                          className={`border-b border-gray-100 ${
                            isDemo || isImported ? 'bg-red-50' : isArchived ? 'opacity-50' : ''
                          }`}
                        >
                          <td className="py-1.5 pr-4 font-mono text-xs text-muted-foreground">
                            {emp.id}
                            {isDemo && <Badge variant="destructive" className="ml-1 text-[10px] py-0">DEMO</Badge>}
                            {isImported && <Badge variant="destructive" className="ml-1 text-[10px] py-0">AUTO</Badge>}
                          </td>
                          <td className="py-1.5 pr-4 font-medium">{emp.name}</td>
                          <td className="py-1.5 pr-4 text-muted-foreground">{emp.department ?? '—'}</td>
                          <td className="py-1.5 pr-4 text-muted-foreground">{emp.restaurant_id ?? '—'}</td>
                          <td className="py-1.5 text-muted-foreground">
                            {emp.employment_end_date
                              ? <span className="text-orange-600">{emp.employment_end_date}</span>
                              : <span className="text-green-600">aktiv</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </ScrollArea>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
