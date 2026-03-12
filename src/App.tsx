import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { RevenueDisplayProvider } from "@/contexts/RevenueDisplayContext";
import { PlanDisplayProvider } from "@/contexts/PlanDisplayContext";
import { GlobalSiteProtection } from "@/components/GlobalSiteProtection";
import Index from "./pages/Index";
import SchedulePlanner from "./pages/SchedulePlanner";
import Settings from "./pages/Settings";
import DepartmentSchedule from "./pages/DepartmentSchedule";
import DepartmentPlannerWrapper from "./pages/DepartmentPlannerWrapper";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <RevenueDisplayProvider>
        <PlanDisplayProvider>
        <Sonner />
        <GlobalSiteProtection>
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<Index />} />
              <Route path="/personal" element={<SchedulePlanner />} />
              <Route path="/schedule-planner" element={<SchedulePlanner />} />
              <Route path="/settings" element={<Settings />} />
              {/* Department access routes */}
              <Route path="/dienstplan/:department" element={<DepartmentSchedule />} />
              <Route path="/plan/:department" element={<DepartmentPlannerWrapper />} />
              {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </BrowserRouter>
        </GlobalSiteProtection>
        </PlanDisplayProvider>
      </RevenueDisplayProvider>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
