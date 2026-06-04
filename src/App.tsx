import { useEffect } from "react";
import { useSyncStore } from "@/hooks/useSyncStore";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
import { GuestBanner } from "@/components/GuestBanner";
import { Loader2 } from "lucide-react";
import { AppNav } from "@/components/AppNav";
import Dashboard from "./pages/Dashboard";
import SollIstAnalyse from "./pages/SollIstAnalyse";
import Personalstamm from "./pages/Personalstamm";
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
import PersonalFixPage from "./pages/PersonalFix";
import DataIntegrityTest from "./pages/DataIntegrityTest";
import ProdukteSeite from "./pages/Produkte";
import AbsenzKostenPage from "./pages/AbsenzKosten";
import ArtikelPage from "./pages/Artikel";
import WesAnalysePage from "./pages/WesAnalyse";
import LunchAnalysePage from "./pages/LunchAnalyse";
import TakeAwayAnalysePage from "./pages/TakeAwayAnalyse";
import ArtikelTrackingPage from "./pages/ArtikelTracking";
import GuestAccess from "./pages/GuestAccess";
import VerkaufsDashboard from "./pages/VerkaufsDashboard";
import SalesUpload from "./pages/SalesUpload";
import ProduktAnalyse from "./pages/ProduktAnalyse";
import KategorienAnalyse from "./pages/KategorienAnalyse";
import ProduktStamm from "./pages/ProduktStamm";
import TagesansichtPage from "./pages/TagesansichtPage";
import TagesControllingPage from "./pages/TagesControllingPage";
import WarenrechnungenPage from "./pages/Warenrechnungen";
import ForecastPlanung from "./pages/ForecastPlanung";
import MirusParserTest from "./pages/MirusParserTest";
import MirusExcelTest from "./pages/MirusExcelTest";
import MirusImportPreview from "./pages/MirusImportPreview";
import MirusReview from "./pages/MirusReview";
import StaffSchedulePage from "./pages/StaffSchedulePage";
import ArbeitszeitblaetterPage from "./pages/ArbeitszeitblaetterPage";
import TimesheetConfirmationPage from "./pages/TimesheetConfirmationPage";
import EmployeeIntegrityPanel from "./pages/EmployeeIntegrityPanel";

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

// ─── BlockedRoute ─────────────────────────────────────────────────────────────
// Wrapper für Navigate-Redirects: loggt [AUTH] blocked route to oliv bevor
// es weiterleitet. Nur aktiv wenn isBeaulieuManager = true.

const BlockedRoute = ({ path, to = '/' }: { path: string; to?: string }) => {
  useEffect(() => {
    console.log(`[AUTH] blocked route: ${path} → redirected to ${to}`);
  }, [path, to]);
  return <Navigate to={to} replace />;
};

// ─── Private App (requires authentication) ──────────────────────────────────

const AppContent = () => {
  const { user, loading } = useAuth();
  const { canAccessSettings, canAccessModule, isBeaulieuManager } = usePermissions();
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
            <Route path="/"
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

            {/* Einstellungen: Admin + beaulieu_manager (nur Beaulieu-relevante Settings) */}
            <Route
              path="/settings"
              element={canAccessSettings ? <Settings /> : <Navigate to="/personal" replace />}
            />

            {/* Reporting + Finanzen: nur Admin – beaulieu_manager wird umgeleitet */}
            <Route path="/reporting"
              element={isBeaulieuManager ? <BlockedRoute path="/reporting" /> : <Reporting />}
            />
            <Route path="/kontenplan"
              element={isBeaulieuManager ? <BlockedRoute path="/kontenplan" /> : <AccountMappingPage />}
            />
            <Route path="/erfolgsrechnung"
              element={isBeaulieuManager ? <BlockedRoute path="/erfolgsrechnung" /> : <PLViewPage />}
            />
            <Route path="/csv-import"
              element={<CSVImportPage />}
            />
            <Route path="/import"
              element={<ImportHub />}
            />
            <Route path="/lieferanten"
              element={<SupplierDocumentsPage />}
            />
            <Route path="/lieferanten-vergleich"
              element={<SupplierComparisonPage />}
            />
            <Route path="/budget"
              element={isBeaulieuManager ? <BlockedRoute path="/budget" /> : <BudgetPage />}
            />
            <Route path="/personal-fix"
              element={canAccessModule('personal_fix') ? <PersonalFixPage /> : <Navigate to="/personal" replace />}
            />
            <Route path="/arbeitszeitblaetter" element={<ArbeitszeitblaetterPage />} />
            <Route path="/integrity-test" element={<DataIntegrityTest />} />
            <Route path="/employee-integrity" element={<EmployeeIntegrityPanel />} />
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
            <Route path="/lunch-analyse"    element={<LunchAnalysePage />} />
            <Route path="/takeaway-analyse" element={<TakeAwayAnalysePage />} />
            <Route path="/absenzen"         element={<AbsenzKostenPage />} />

            {/* Verkaufsdaten & Produktanalyse */}
            <Route path="/tagesansicht"
              element={canAccessModule('tagesansicht') ? <TagesansichtPage /> : <Navigate to="/personal" replace />}
            />
            <Route path="/tages-controlling"
              element={canAccessModule('tages_controlling') ? <TagesControllingPage /> : <Navigate to="/personal" replace />}
            />
            <Route path="/forecast" element={<ForecastPlanung />} />
            <Route path="/verkauf-dashboard"
              element={<VerkaufsDashboard />}
            />
            <Route path="/sales-upload"
              element={<SalesUpload />}
            />
            <Route path="/produkt-analyse"   element={<ProduktAnalyse />} />
            <Route path="/kategorien"        element={<KategorienAnalyse />} />
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
                <BrowserRouter>
                  <Routes>
                    {/* ── Öffentliche Routen — kein Login erforderlich ── */}
                    <Route path="/onboarding/:token" element={<OnboardingForm />} />
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
