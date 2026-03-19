import { useEffect } from "react";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { RevenueDisplayProvider } from "@/contexts/RevenueDisplayContext";
import { PlanDisplayProvider } from "@/contexts/PlanDisplayContext";
import { AuthProvider } from "@/contexts/AuthContext";
import { StichtagProvider } from "@/contexts/StichtagContext";
import { GuestSessionProvider, GUEST_SESSION_KEY } from "@/contexts/GuestSessionContext";
import { useAuth } from "@/hooks/useAuth";
import { usePermissions } from "@/hooks/usePermissions";
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
import GuestAccess from "./pages/GuestAccess";

const queryClient = new QueryClient();

// ─── Private App (requires authentication) ──────────────────────────────────

const AppContent = () => {
  const { user, loading } = useAuth();
  const { canAccessSettings, canAccessModule } = usePermissions();

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
    <div className="flex flex-col min-h-screen bg-background">
      <GuestBanner />
      <div className="flex flex-1 min-h-0">
        <AppNav />

        {/* Haupt-Inhaltsbereich */}
        <div className="flex-1 min-w-0 pb-16 md:pb-0">
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

            {/* Personalstamm: alle Rollen, Inhalt rollenbasiert gefiltert */}
            <Route path="/personal-stamm" element={<Personalstamm />} />

            {/* Einstellungen: nur Admin */}
            <Route
              path="/settings"
              element={canAccessSettings ? <Settings /> : <Navigate to="/" replace />}
            />

            {/* Reporting: Finanzmodul (nur Admin) */}
            <Route path="/reporting"        element={<Reporting />} />
            <Route path="/kontenplan"       element={<AccountMappingPage />} />
            <Route path="/erfolgsrechnung"  element={<PLViewPage />} />
            <Route path="/csv-import"       element={<CSVImportPage />} />
            <Route path="/import"           element={<ImportHub />} />
            <Route path="/lieferanten"          element={<SupplierDocumentsPage />} />
            <Route path="/lieferanten-vergleich" element={<SupplierComparisonPage />} />
            <Route path="/budget"           element={<BudgetPage />} />

            {/* Abteilungs-Dienstpläne */}
            <Route path="/dienstplan/:department" element={<DepartmentSchedule />} />
            <Route path="/plan/:department"       element={<DepartmentPlannerWrapper />} />

            {/* Legacy */}
            <Route path="/overview" element={<Index />} />

            <Route path="*" element={<NotFound />} />
          </Routes>
        </div>
      </div>
    </div>
  );
};

// ─── Root App — BrowserRouter hier oben, damit öffentliche Routen möglich ───

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <StichtagProvider>
      <RevenueDisplayProvider>
        <PlanDisplayProvider>
          <GuestSessionProvider>
            <Sonner />
            <AuthProvider>
              <BrowserRouter>
                <Routes>
                  {/* ── Öffentliche Routen — kein Login erforderlich ── */}
                  <Route path="/onboarding/:token" element={<OnboardingForm />} />
                  <Route path="/gast" element={<GuestAccess />} />

                  {/* ── Alle anderen Routen → Auth-Check ── */}
                  <Route path="/*" element={<AppContent />} />
                </Routes>
              </BrowserRouter>
            </AuthProvider>
          </GuestSessionProvider>
        </PlanDisplayProvider>
      </RevenueDisplayProvider>
      </StichtagProvider>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
