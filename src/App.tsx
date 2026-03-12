import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { RevenueDisplayProvider } from "@/contexts/RevenueDisplayContext";
import { PlanDisplayProvider } from "@/contexts/PlanDisplayContext";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { LoginPage } from "@/components/LoginPage";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LogOut, Loader2 } from "lucide-react";
import Index from "./pages/Index";
import SchedulePlanner from "./pages/SchedulePlanner";
import Settings from "./pages/Settings";
import DepartmentSchedule from "./pages/DepartmentSchedule";
import DepartmentPlannerWrapper from "./pages/DepartmentPlannerWrapper";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const AppContent = () => {
  const { user, loading, signOut } = useAuth();

  // Wenn der Nutzer eingeloggt ist, entsperren wir automatisch
  // die internen Passwortschutzbereiche (z.B. Gehaltsdaten).
  // Die echte Sicherheit liegt jetzt beim Supabase-Login.
  if (user) {
    sessionStorage.setItem('dashboard_unlocked', 'true');
    sessionStorage.setItem('settings_unlocked', 'true');
    sessionStorage.setItem('salary_columns_unlocked', 'true');
  }

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
          <Route path="/" element={<Index />} />
          <Route path="/personal" element={<SchedulePlanner />} />
          <Route path="/schedule-planner" element={<SchedulePlanner />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/dienstplan/:department" element={<DepartmentSchedule />} />
          <Route path="/plan/:department" element={<DepartmentPlannerWrapper />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            onClick={signOut}
            className="fixed bottom-4 right-4 z-50 h-10 w-10 rounded-full shadow-lg bg-background border-destructive/50 hover:bg-destructive/10 hover:border-destructive"
          >
            <LogOut className="h-4 w-4 text-destructive" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">
          <p>Abmelden ({user.email})</p>
        </TooltipContent>
      </Tooltip>
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
