import { useEffect, useRef } from "react";
import { useSyncStore } from "@/hooks/useSyncStore";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { RevenueDisplayProvider } from "@/contexts/RevenueDisplayContext";
import { PlanDisplayProvider } from "@/contexts/PlanDisplayContext";
import { MaisonProvider } from "@/contexts/MaisonContext";
import { AuthProvider } from "@/contexts/AuthContext";
import { StichtagProvider } from "@/contexts/StichtagContext";
import { GuestSessionProvider, GUEST_SESSION_KEY } from "@/contexts/GuestSessionContext";
import { TenantProvider } from "@/contexts/TenantContext";
import { useAuth } from "@/hooks/useAuth";
import { usePermissions } from "@/hooks/usePermissions";
import { useTenant } from "@/contexts/TenantContext";
import { LoginPage } from "@/components/LoginPage";
import { RequireAdmin } from "@/components/RequireAdmin";
import { GuestBanner } from "@/components/GuestBanner";
import { Loader2 } from "lucide-react";
import { AppNav } from "@/components/AppNav";
import Dashboard from "./pages/Dashboard";
import StartOverview from "./pages/StartOverview";
import SollIstAnalyse from "./pages/SollIstAnalyse";
import Personalstamm from "./pages/Personalstamm";
import PersonaleintrittListe from "./pages/PersonaleintrittListe";
import PersonaleintrittNeu from "./pages/PersonaleintrittNeu";
import PersonaleintrittDetail from "./pages/PersonaleintrittDetail";
import MitarbeiterEintritt from "./pages/MitarbeiterEintritt";
import Positionen from "./pages/Positionen";
import Personalbedarf from "./pages/Personalbedarf";
import Reporting from "./pages/Reporting";
import AccountMappingPage from "./pages/AccountMapping";
import PLViewPage from "./pages/PLView";
import CSVImportPage from "./pages/CSVImport";
import SupplierDocumentsPage from "./pages/SupplierDocuments";
import SupplierComparisonPage from "./pages/SupplierComparison";
import BudgetPage from "./pages/Budget";
import Index from "./pages/Index";
import SchedulePlanner from "./pages/SchedulePlanner";
import Settings from "./pages/Settings";
import DepartmentSchedule from "./pages/DepartmentSchedule";
import DepartmentPlannerWrapper from "./pages/DepartmentPlannerWrapper";
import NotFound from "./pages/NotFound";
import OnboardingForm from "./pages/OnboardingForm";
import ImportHub from "./pages/ImportHub";
import ImportCockpitPage from "./pages/ImportCockpitPage";
import PersonalFixPage from "./pages/PersonalFix";
import DataIntegrityTest from "./pages/DataIntegrityTest";
import ProdukteSeite from "./pages/Produkte";
import AbsenzKostenPage from "./pages/AbsenzKosten";
import ArtikelPage from "./pages/Artikel";
import WesAnalysePage from "./pages/WesAnalyse";
import ArtikelTrackingPage from "./pages/ArtikelTracking";
import GuestAccess from "./pages/GuestAccess";
import VerkaufsDashboard from "./pages/VerkaufsDashboard";
import SalesUpload from "./pages/SalesUpload";
import ProduktAnalyse from "./pages/ProduktAnalyse";
import ProduktDetail from "./pages/ProduktDetail";
import ProduktStamm from "./pages/ProduktStamm";
import TagesansichtPage from "./pages/TagesansichtPage";
import TagesControllingPage from "./pages/TagesControllingPage";
import KennzahlenBerichtPage from "./pages/KennzahlenBerichtPage";
import WarenrechnungenPage from "./pages/Warenrechnungen";
import ForecastPlanung from "./pages/ForecastPlanung";
import MirusParserTest from "./pages/MirusParserTest";
import MirusExcelTest from "./pages/MirusExcelTest";
import MirusImportPreview from "./pages/MirusImportPreview";
import MirusReview from "./pages/MirusReview";
import StaffSchedulePage from "./pages/StaffSchedulePage";
import TimesheetConfirmationPage from "./pages/TimesheetConfirmationPage";
import EmployeeIntegrityPanel from "./pages/EmployeeIntegrityPanel";
import UmsatzAbstimmungPage from "./pages/UmsatzAbstimmungPage";
import TagesabschluessePage from "./pages/TagesabschluessePage";
import OpListePage from "./pages/OpListe";
import GastronoviZBerichtPage from "./pages/GastronoviZBerichtPage";
import ForatableImportPage from "./pages/ForatableImportPage";
import GaesteCrmPage from "./pages/GaesteCrmPage";
import CrmAuswertungPage from "./pages/CrmAuswertungPage";
import ReservationWochentagPage from "./pages/ReservationWochentagPage";
import ReservationVorjahrPage from "./pages/ReservationVorjahrPage";
import ReservationAnalysePage from "./pages/ReservationAnalysePage";
import GaesteDetailPage from "./pages/GaesteDetailPage";
import GaesteDuplikatePage from "./pages/GaesteDuplikatePage";

const queryClient = new QueryClient();

// ─── TenantLockEnforcer ──────────────────────────────────────────────────────
// Sitzt innerhalb von AuthProvider und erzwingt den Tenant-Lock für
// beaulieu_manager. Brücke zwischen AuthContext (innen) und TenantContext (außen).

const TenantLockEnforcer = () => {
  const { role } = useAuth();
  const { lockTenant, unlockTenant, tenantLocked } = useTenant();
  // beaulieu_manager und beaulieu_viewer werden beide auf den Beaulieu-Mandanten gesperrt
  const isBeaulieuRole = role === 'beaulieu_manager' || role === 'beaulieu_viewer';
  useEffect(() => {
    if (isBeaulieuRole && !tenantLocked) {
      lockTenant('beaulieu');
      console.log(`[AUTH] TenantLockEnforcer: ${role} → tenant locked to beaulieu`);
    } else if (!isBeaulieuRole && tenantLocked) {
      unlockTenant();
      console.log(`[AUTH] TenantLockEnforcer: role="${role}" → tenant lock released`);
    }
  }, [role, isBeaulieuRole, tenantLocked, lockTenant, unlockTenant]);
  return null;
};

// ─── LogoutStateBridge ───────────────────────────────────────────────────────
// Immer gemountet (auch auf der LoginPage). Leert bei Logout oder direktem
// Benutzerwechsel den Tenant-State und den React-Query-Cache, damit ein
// neuer Login keine Auswahl/Daten des vorherigen Benutzers übernimmt.
// Läuft NICHT bei Token-Refresh (user.id bleibt gleich) und nicht beim Boot.

const LogoutStateBridge = () => {
  const { user } = useAuth();
  const { resetTenant } = useTenant();
  const queryClient = useQueryClient();
  // undefined = noch kein Beobachtungswert (Boot), null = ausgeloggt
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const curr = user?.id ?? null;
    const prev = prevUserIdRef.current;
    prevUserIdRef.current = curr;

    if (prev === undefined) return;          // Boot: keine Transition
    if (prev === curr) return;               // kein Wechsel (inkl. Token-Refresh)

    if (prev !== null) {
      // Logout (curr=null) ODER direkter Benutzerwechsel (curr=andere ID)
      resetTenant();
      queryClient.clear();
      console.log(`[AUTH] LogoutStateBridge: ${curr === null ? 'Logout' : 'Benutzerwechsel'} → Tenant-State + Query-Cache geleert`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  return null;
};

// ─── BlockedRoute ─────────────────────────────────────────────────────────────
// Wrapper für Navigate-Redirects: loggt [AUTH] blocked route to oliv bevor
// es weiterleitet. Nur aktiv wenn isBeaulieuManager = true.

const BlockedRoute = ({ path, to = '/' }: { path: string; to?: string }) => {
  useEffect(() => {
    console.log(`[AUTH] blocked route: ${path} → redirected to ${to}`);
  }, [path, to]);
  return <Navigate to={to} replace />;
};

// ─── RequireAdmin ─────────────────────────────────────────────────────────────
// Zentraler Route-Guard für admin-only Flächen — ausgelagert nach
// src/components/RequireAdmin.tsx (isoliert testbar), hier nur re-importiert.

// ─── Private App (requires authentication) ──────────────────────────────────

const AppContent = () => {
  const { user, loading, roleResolved } = useAuth();
  const { canAccessSettings, canAccessModule, isBeaulieuManager, isAdmin } = usePermissions();
  const { tenantId } = useTenant();

  // [AUTH] Debug-Logs für beaulieu_manager beim Mount
  useEffect(() => {
    if (isBeaulieuManager) {
      console.log('[AUTH] role: beaulieu_manager');
      console.log('[AUTH] tenant locked: beaulieu');
      console.log('[AUTH] module budget: blocked');
      console.log('[AUTH] module erfolgsrechnung: blocked');
      console.log('[AUTH] allowed modules: dashboard, tagesansicht, tages-controlling, verkauf-dashboard, produkt-analyse, dienstplanung, personal-fix, personalstamm, produkt-stamm, warenrechnungen, wes-analyse, lieferanten, lieferanten-vergleich, import, sales-upload, settings');
    }
  }, [isBeaulieuManager]);

  // Daten aus Supabase nach localStorage synchronisieren (einmalig nach Login)
  useSyncStore(!!user);

  // Check for valid guest session
  const hasGuestSession = (() => {
    try {
      const raw = sessionStorage.getItem(GUEST_SESSION_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      return parsed.expiresAt > Date.now();
    } catch { return false; }
  })();

  useEffect(() => {
    if (user) {
      sessionStorage.setItem('dashboard_unlocked', 'true');
      sessionStorage.setItem('settings_unlocked', 'true');
      sessionStorage.setItem('salary_columns_unlocked', 'true');
    } else if (!hasGuestSession) {
      sessionStorage.removeItem('dashboard_unlocked');
      sessionStorage.removeItem('settings_unlocked');
      sessionStorage.removeItem('salary_columns_unlocked');
    }
  }, [user, hasGuestSession]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user && !hasGuestSession) {
    return <LoginPage />;
  }

  // Rollen-Gate: Solange die Rolle des eingeloggten Users nicht verbindlich
  // feststeht (erster Login in diesem Browser, keine persistierte Rolle),
  // KEINE rollen-gegateten Routen rendern — sonst kurzzeitig falsche
  // Navigation/Berechtigungen und fehlgeleitete Redirects.
  if (user && !roleResolved) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-background">
      <GuestBanner />
      <div className="flex flex-1 min-h-0">
        <AppNav />

        {/* Haupt-Inhaltsbereich */}
        <div className="flex-1 min-w-0 min-h-0 flex flex-col pb-16 md:pb-0">
          {/* Tenant-Lock für beaulieu_manager — läuft auf jeder Seite */}
          <TenantLockEnforcer />
          <div className="flex-1 min-h-0 overflow-auto" key={tenantId}>
          <ErrorBoundary label="Seite">
          <Routes>
            {/* Routen mit Rollenprüfung */}
            {/* Startseite: Admins (inkl. Gast-Lesezugriff) → vereinfachte Übersicht;
                Manager behalten ihr bisheriges Dashboard-Verhalten. */}
            <Route path="/"
              element={isAdmin
                ? <StartOverview />
                : canAccessModule('dashboard')
                  ? <Dashboard />
                  : <Navigate to="/personal" replace />}
            />
            {/* Ausführliches Dashboard bleibt vollständig erhalten (Detailseite). */}
            <Route path="/dashboard"
              element={canAccessModule('dashboard')
                ? <Dashboard />
                : <Navigate to="/personal" replace />}
            />
            <Route path="/personal"         element={<SchedulePlanner />} />
            <Route path="/schedule-planner" element={<SchedulePlanner />} />
            <Route path="/analyse"
              element={canAccessModule('soll_ist_analyse')
                ? <SollIstAnalyse />
                : <Navigate to="/personal" replace />}
            />

            {/* Personalstamm: Admin + beaulieu_manager (tenant-gefiltert) */}
            <Route path="/personal-stamm" element={<Personalstamm />} />

            {/* Personaleintritt (digitaler L-GAV-Eintrittsprozess):
                PII-/Schreibfläche — Admin OHNE Gäste + beaulieu_manager */}
            <Route path="/personaleintritt"
              element={<RequireAdmin path="/personaleintritt" allowGuest={false} allowBeaulieu><PersonaleintrittListe /></RequireAdmin>}
            />
            <Route path="/personaleintritt/neu"
              element={<RequireAdmin path="/personaleintritt/neu" allowGuest={false} allowBeaulieu><PersonaleintrittNeu /></RequireAdmin>}
            />
            <Route path="/personaleintritt/:id"
              element={<RequireAdmin path="/personaleintritt/:id" allowGuest={false} allowBeaulieu><PersonaleintrittDetail /></RequireAdmin>}
            />

            {/* Positionsverwaltung: nur Admin */}
            <Route path="/positionen"
              element={canAccessModule('positionen') ? <Positionen /> : <Navigate to="/personal" replace />}
            />

            {/* Personalbedarf (SOLL-Besetzung je Saison × Wochentag): nur Admin */}
            <Route path="/personalbedarf"
              element={canAccessModule('personalbedarf') ? <Personalbedarf /> : <Navigate to="/personal" replace />}
            />

            {/* Einstellungen: Admin + beaulieu_manager (nur Beaulieu-relevante Settings) */}
            <Route
              path="/settings"
              element={canAccessSettings ? <Settings /> : <Navigate to="/personal" replace />}
            />

            {/* Reporting + Finanzen: nur Admin (inkl. Gast-Lesezugriff) —
                beaulieu_manager und service/kueche_manager werden umgeleitet */}
            <Route path="/reporting"
              element={<RequireAdmin path="/reporting"><Reporting /></RequireAdmin>}
            />
            <Route path="/kontenplan"
              element={<RequireAdmin path="/kontenplan"><AccountMappingPage /></RequireAdmin>}
            />
            <Route path="/erfolgsrechnung"
              element={<RequireAdmin path="/erfolgsrechnung"><PLViewPage /></RequireAdmin>}
            />
            {/* Import-Flächen (Schreibaktionen): nur Admin, keine Gast-Sessions */}
            <Route path="/csv-import"
              element={<RequireAdmin path="/csv-import" allowGuest={false}><CSVImportPage /></RequireAdmin>}
            />
            <Route path="/import"
              element={<ImportHub />}
            />
            {/* Import-Cockpit: read-only Frische-/Fälligkeits-Übersicht — nur Admin, keine Gäste */}
            <Route path="/import-cockpit"
              element={isAdmin && !hasGuestSession ? <ImportCockpitPage /> : <Navigate to="/" replace />}
            />
            <Route path="/lieferanten"
              element={<SupplierDocumentsPage />}
            />
            <Route path="/lieferanten-vergleich"
              element={<SupplierComparisonPage />}
            />
            <Route path="/budget"
              element={<RequireAdmin path="/budget"><BudgetPage /></RequireAdmin>}
            />
            <Route path="/personal-fix"
              element={canAccessModule('personal_fix') ? <PersonalFixPage /> : <Navigate to="/personal" replace />}
            />
            {/* Integritäts-/Admin-Werkzeuge: nur Admin, keine Gast-Sessions */}
            <Route path="/integrity-test"
              element={<RequireAdmin path="/integrity-test" allowGuest={false}><DataIntegrityTest /></RequireAdmin>}
            />
            <Route path="/employee-integrity"
              element={<RequireAdmin path="/employee-integrity" allowGuest={false} redirectTo="/personal"><EmployeeIntegrityPanel /></RequireAdmin>}
            />
            <Route path="/umsatzabstimmung"
              element={<RequireAdmin path="/umsatzabstimmung"><UmsatzAbstimmungPage /></RequireAdmin>}
            />
            <Route path="/tagesabschluesse"
              element={<RequireAdmin path="/tagesabschluesse"><TagesabschluessePage /></RequireAdmin>}
            />
            <Route path="/op-liste"
              element={<RequireAdmin path="/op-liste"><OpListePage /></RequireAdmin>}
            />
            <Route path="/gastronovi-import"
              element={<RequireAdmin path="/gastronovi-import" allowGuest={false}><GastronoviZBerichtPage /></RequireAdmin>}
            />
            <Route path="/foratable-import"
              element={<RequireAdmin path="/foratable-import" allowGuest={false}><ForatableImportPage /></RequireAdmin>}
            />
            <Route path="/reservationen-import" element={<Navigate to="/foratable-import" replace />} />
            <Route path="/gaeste-import" element={<Navigate to="/foratable-import?tab=gaeste" replace />} />
            <Route path="/foratable-report" element={<Navigate to="/gaeste/auswertung" replace />} />
            {/* Gäste-CRM (PII): nur Admin UND keine Gast-Session — spiegelt die
                seiteninternen Gates (isAdmin && !isGuest) als Route-Guard */}
            <Route path="/gaeste"
              element={<RequireAdmin path="/gaeste" allowGuest={false}><GaesteCrmPage /></RequireAdmin>}
            />
            <Route path="/gaeste/auswertung"
              element={<RequireAdmin path="/gaeste/auswertung" allowGuest={false}><CrmAuswertungPage /></RequireAdmin>}
            />
            <Route path="/gaeste/analyse"
              element={<RequireAdmin path="/gaeste/analyse" allowGuest={false}><ReservationAnalysePage /></RequireAdmin>}
            />
            <Route path="/gaeste/wochentag"
              element={<RequireAdmin path="/gaeste/wochentag" allowGuest={false}><ReservationWochentagPage /></RequireAdmin>}
            />
            <Route path="/gaeste/vorjahr"
              element={<RequireAdmin path="/gaeste/vorjahr" allowGuest={false}><ReservationVorjahrPage /></RequireAdmin>}
            />
            <Route path="/gaeste/duplikate"
              element={<RequireAdmin path="/gaeste/duplikate" allowGuest={false}><GaesteDuplikatePage /></RequireAdmin>}
            />
            <Route path="/gaeste/:guestId"
              element={<RequireAdmin path="/gaeste/:guestId" allowGuest={false}><GaesteDetailPage /></RequireAdmin>}
            />
            <Route path="/produkte"
              element={<ProdukteSeite />}
            />
            <Route path="/artikel"          element={<ArtikelPage />} />
            <Route path="/artikel-tracking" element={<ArtikelTrackingPage />} />
            <Route path="/warenrechnungen"
              element={canAccessModule('warenrechnungen') ? <WarenrechnungenPage /> : <Navigate to="/personal" replace />}
            />
            <Route path="/wes-analyse"
              element={<WesAnalysePage />}
            />
            {/* Konsolidiert in die Produktanalyse — alte Routen als Redirect auf den Tab */}
            <Route path="/lunch-analyse"    element={<Navigate to="/produkt-analyse?tab=lunch" replace />} />
            <Route path="/takeaway-analyse" element={<Navigate to="/produkt-analyse?tab=takeaway" replace />} />
            <Route path="/absenzen"         element={<AbsenzKostenPage />} />

            {/* Verkaufsdaten & Produktanalyse */}
            <Route path="/tagesansicht"
              element={canAccessModule('tagesansicht') ? <TagesansichtPage /> : <Navigate to="/personal" replace />}
            />
            <Route path="/tages-controlling"
              element={canAccessModule('tages_controlling') ? <TagesControllingPage /> : <Navigate to="/personal" replace />}
            />
            {/* Kennzahlen-Bericht: Admin (inkl. Gast) + beaulieu_manager (wie Nav) */}
            <Route path="/kennzahlen-bericht"
              element={<RequireAdmin path="/kennzahlen-bericht" allowBeaulieu><KennzahlenBerichtPage /></RequireAdmin>}
            />
            <Route path="/forecast" element={<ForecastPlanung />} />
            <Route path="/verkauf-dashboard"
              element={<VerkaufsDashboard />}
            />
            <Route path="/sales-upload"
              element={<SalesUpload />}
            />
            <Route path="/produkt-analyse"   element={<ProduktAnalyse />} />
            <Route path="/produkt-analyse/produkt" element={<ProduktDetail />} />
            <Route path="/kategorien"        element={<Navigate to="/produkt-analyse?tab=kategorien" replace />} />
            <Route path="/produkt-stamm"
              element={<ProduktStamm />}
            />

            {/* Abteilungs-Dienstpläne */}
            <Route path="/dienstplan/:department" element={<DepartmentSchedule />} />
            <Route path="/plan/:department"       element={<DepartmentPlannerWrapper />} />

            {/* Legacy – beaulieu_manager darf nicht auf die Oliv-Overview */}
            <Route path="/overview"
              element={isBeaulieuManager ? <BlockedRoute path="/overview" /> : <Index />}
            />

            <Route path="*" element={<NotFound />} />
          </Routes>
          </ErrorBoundary>
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── Root App — BrowserRouter hier oben, damit öffentliche Routen möglich ───

const App = () => {
  // ── Komplett isolierte öffentliche Seiten ────────────────────────────────
  // Kein AuthProvider, kein Tenant-Redirect, kein Router-Redirect.
  // Muss VOR jedem Provider stehen, damit nichts dazwischenfunken kann.
  if (window.location.pathname === '/mirus-parser-test') {
    return <MirusParserTest />;
  }
  if (window.location.pathname === '/mirus-excel-test') {
    return <MirusExcelTest />;
  }
  if (window.location.pathname === '/mirus-import-preview') {
    return <MirusImportPreview />;
  }
  if (window.location.pathname === '/mirus-review') {
    return <MirusReview />;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <TenantProvider>
        <StichtagProvider>
        <RevenueDisplayProvider>
        <MaisonProvider>
          <PlanDisplayProvider>
            <GuestSessionProvider>
              <Sonner />
              <AuthProvider>
                <LogoutStateBridge />
                <BrowserRouter>
                  <Routes>
                    {/* ── Öffentliche Routen — kein Login erforderlich ── */}
                    <Route path="/onboarding/:token" element={<OnboardingForm />} />
                    {/* Personaleintritt Phase 2: Mitarbeiter füllt per Einladungs-Token aus
                        (Edge Function personaleintritt-public, kein direkter DB-Zugriff) */}
                    <Route path="/e/:token" element={<MitarbeiterEintritt />} />
                    <Route path="/staff-schedule/:token" element={<StaffSchedulePage />} />
                    <Route path="/timesheet-confirmation/:token" element={<TimesheetConfirmationPage />} />
                    <Route path="/gast" element={<GuestAccess />} />

                    {/* ── Alle anderen Routen → Auth-Check ── */}
                    <Route path="/*" element={<AppContent />} />
                  </Routes>
                </BrowserRouter>
              </AuthProvider>
            </GuestSessionProvider>
          </PlanDisplayProvider>
        </MaisonProvider>
        </RevenueDisplayProvider>
        </StichtagProvider>
        </TenantProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
};

export default App;
