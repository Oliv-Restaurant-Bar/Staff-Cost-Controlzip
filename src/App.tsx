import { useEffect } from "react";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { RevenueDisplayProvider } from "@/contexts/RevenueDisplayContext";
import { PlanDisplayProvider } from "@/contexts/PlanDisplayContext";
import { AuthProvider } from "@/contexts/AuthContext";
import { useAuth } from "@/hooks/useAuth";
import { usePermissions } from "@/hooks/usePermissions";
import { LoginPage } from "@/components/LoginPage";
import { Loader2 } from "lucide-react";
import { AppNav } from "@/components/AppNav";
import Dashboard from "./pages/Dashboard";
import SollIstAnalyse from "./pages/SollIstAnalyse";
import Personalstamm from "./pages/Personalstamm";
import Reporting from "./pages/Reporting";
import AccountMappingPage from "./pages/AccountMapping";
import PLViewPage from "./pages/PLView";
import CSVImportPage from "./pages/CSVImport";
import Index from "./pages/Index";
import SchedulePlanner from "./pages/SchedulePlanner";
import Settings from "./pages/Settings";
import DepartmentSchedule from "./pages/DepartmentSchedule";
import DepartmentPlannerWrapper from "./pages/DepartmentPlannerWrapper";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const AppContent = () => {
  const { user, loading } = useAuth();
  const { canAccessSettings } = usePermissions();

  useEffect(() => {
    if (user) {
      sessionStorage.setItem('dashboard_unlocked', 'true');
      sessionStorage.setItem('settings_unlocked', 'true');
      sessionStorage.setItem('salary_columns_unlocked', 'true');
    } else {
      sessionStorage.removeItem('dashboard_unlocked');
      sessionStorage.removeItem('settings_unlocked');
      sessionStorage.removeItem('salary_columns_unlocked');
    }
  }, [user]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  return (
    <BrowserRouter>
      {/*
        Flex-Layout:
          - Desktop: AppSidebar (220px) links | Content-Bereich rechts
          - Mobile:  Content-Bereich full-width | AppBottomNav unten fixiert
      */}
      <div className="flex min-h-screen bg-background">
        <AppNav />

        {/* Haupt-Inhaltsbereich */}
        <div className="flex-1 min-w-0 pb-16 md:pb-0">
          <Routes>
            {/* Öffentlich für alle angemeldeten Nutzer */}
            <Route path="/"               element={<Dashboard />} />
            <Route path="/personal"       element={<SchedulePlanner />} />
            <Route path="/schedule-planner" element={<SchedulePlanner />} />
            <Route path="/analyse"        element={<SollIstAnalyse />} />

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

            {/* Abteilungs-Dienstpläne */}
            <Route path="/dienstplan/:department" element={<DepartmentSchedule />} />
            <Route path="/plan/:department"       element={<DepartmentPlannerWrapper />} />

            {/* Legacy */}
            <Route path="/overview" element={<Index />} />

            <Route path="*" element={<NotFound />} />
          </Routes>
        </div>
      </div>
    </BrowserRouter>
  );
};

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <RevenueDisplayProvider>
        <PlanDisplayProvider>
          <Sonner />
          <AuthProvider>
            <AppContent />
          </AuthProvider>
        </PlanDisplayProvider>
      </RevenueDisplayProvider>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
