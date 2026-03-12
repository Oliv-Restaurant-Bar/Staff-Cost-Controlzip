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
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LogOut, Loader2, ShieldCheck, Users, ChefHat } from "lucide-react";
import Dashboard from "./pages/Dashboard";
import SollIstAnalyse from "./pages/SollIstAnalyse";
import Personalstamm from "./pages/Personalstamm";
import Index from "./pages/Index";
import SchedulePlanner from "./pages/SchedulePlanner";
import Settings from "./pages/Settings";
import DepartmentSchedule from "./pages/DepartmentSchedule";
import DepartmentPlannerWrapper from "./pages/DepartmentPlannerWrapper";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const RoleBadge = () => {
  const { role, isAdmin, isServiceManager } = usePermissions();
  const labels: Record<string, { label: string; color: string }> = {
    admin:           { label: 'Admin',           color: 'bg-purple-100 text-purple-700 border-purple-300 dark:bg-purple-900/40 dark:text-purple-300' },
    service_manager: { label: 'Service-Manager', color: 'bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-900/40 dark:text-blue-300' },
    kueche_manager:  { label: 'Küchen-Manager',  color: 'bg-orange-100 text-orange-700 border-orange-300 dark:bg-orange-900/40 dark:text-orange-300' },
  };
  const badge = labels[role] ?? labels.admin;
  const Icon = isAdmin ? ShieldCheck : isServiceManager ? Users : ChefHat;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border ${badge.color}`}>
      <Icon className="h-3 w-3" />
      {badge.label}
    </span>
  );
};

const AppContent = () => {
  const { user, loading, signOut } = useAuth();
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
    <>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/analyse" element={<SollIstAnalyse />} />
          <Route path="/personal-stamm" element={<Personalstamm />} />
          <Route path="/overview" element={<Index />} />
          <Route path="/personal" element={<SchedulePlanner />} />
          <Route path="/schedule-planner" element={<SchedulePlanner />} />
          {/* Settings: nur für Admin zugänglich */}
          <Route
            path="/settings"
            element={canAccessSettings ? <Settings /> : <Navigate to="/" replace />}
          />
          <Route path="/dienstplan/:department" element={<DepartmentSchedule />} />
          <Route path="/plan/:department" element={<DepartmentPlannerWrapper />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>

      {/* Abmelden-Button mit Rollen-Badge */}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
        <RoleBadge />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              onClick={signOut}
              className="h-10 w-10 rounded-full shadow-lg bg-background border-destructive/50 hover:bg-destructive/10 hover:border-destructive"
            >
              <LogOut className="h-4 w-4 text-destructive" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">
            <p>Abmelden ({user.email})</p>
          </TooltipContent>
        </Tooltip>
      </div>
    </>
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
