/**
 * ForatableImportPage — gebündelte Foratable-Importe
 * ===================================================
 * Fasst die beiden Foratable-Importe unter einer Route (`/foratable-import`)
 * mit zwei Reitern zusammen:
 *  - „Reservationen": ReservationenImportPage (eingebettet)
 *  - „Gäste / CRM":   GaesteImportPage (eingebettet)
 *
 * Der aktive Reiter wird über den Query-Parameter `?tab=` gesteuert
 * (`reservationen` = Standard, `gaeste`), damit Altlinks/Redirects gezielt auf
 * den richtigen Reiter zeigen. Beide Seiten bleiben dauerhaft gemountet
 * (`forceMount`), damit der jeweilige Upload-/Wizard-Zustand beim Reiterwechsel
 * erhalten bleibt; der inaktive Reiter wird nur per CSS ausgeblendet.
 * Admin-only (Gast-Sessions werden umgeleitet).
 */

import { Navigate, Link, useSearchParams } from 'react-router-dom';
import { Upload, Users, CalendarRange, Contact } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { usePermissions } from '@/hooks/usePermissions';
import { useGuestSession } from '@/contexts/GuestSessionContext';
import ReservationenImportPage from './ReservationenImportPage';
import GaesteImportPage from './GaesteImportPage';

type ImportTab = 'reservationen' | 'gaeste';

export default function ForatableImportPage() {
  const { isAdmin } = usePermissions();
  const { isGuest } = useGuestSession();
  const [searchParams, setSearchParams] = useSearchParams();

  // usePermissions().isAdmin schliesst Gäste ein — daher hier explizit ausschliessen.
  if (!isAdmin || isGuest) return <Navigate to="/" replace />;

  const tab: ImportTab = searchParams.get('tab') === 'gaeste' ? 'gaeste' : 'reservationen';
  const setTab = (t: ImportTab) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', t);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="mx-auto max-w-5xl p-4 md:p-6 space-y-5">
      {/* Kopf */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Upload className="h-6 w-6 text-primary" />
            Foratable Import
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Foratable-Exporte importieren — Reservationen für Gäste- und
            Auslastungsanalysen sowie den Gästeexport zur CRM-Anreicherung.
          </p>
        </div>
        <Link
          to="/gaeste"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-muted/60"
        >
          <Users className="h-4 w-4" />
          Zum Gäste-CRM
        </Link>
      </div>

      <Tabs value={tab} onValueChange={v => setTab(v as ImportTab)}>
        <TabsList>
          <TabsTrigger value="reservationen" className="gap-1.5">
            <CalendarRange className="h-4 w-4" />
            Reservationen
          </TabsTrigger>
          <TabsTrigger value="gaeste" className="gap-1.5">
            <Contact className="h-4 w-4" />
            Gäste / CRM
          </TabsTrigger>
        </TabsList>

        <TabsContent value="reservationen" forceMount className={cn('mt-4', tab !== 'reservationen' && 'hidden')}>
          <ReservationenImportPage embedded />
        </TabsContent>
        <TabsContent value="gaeste" forceMount className={cn('mt-4', tab !== 'gaeste' && 'hidden')}>
          <GaesteImportPage embedded />
        </TabsContent>
      </Tabs>
    </div>
  );
}
