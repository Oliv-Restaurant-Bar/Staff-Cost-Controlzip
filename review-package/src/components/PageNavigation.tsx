import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { 
  BarChart3, 
  Euro, 
  Clock, 
  Users, 
  TrendingUp,
  CalendarDays,
  FileSpreadsheet,
  ChevronUp,
  Menu,
  X
} from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';

interface NavSection {
  id: string;
  label: string;
  icon: React.ElementType;
  priority: 'high' | 'medium' | 'low';
}

const sections: NavSection[] = [
  { id: 'tagesübersicht', label: 'Tagesübersicht', icon: BarChart3, priority: 'high' },
  { id: 'umsatz-vergleich', label: 'Umsatz Plan/Ist', icon: TrendingUp, priority: 'high' },
  { id: 'personalkosten', label: 'Personalkosten', icon: Euro, priority: 'high' },
  { id: 'schicht-umsatz', label: 'Schicht-Umsatz', icon: Clock, priority: 'medium' },
  { id: 'stunden-editor', label: 'Stunden', icon: CalendarDays, priority: 'medium' },
  { id: 'kpi-dashboard', label: 'KPI Dashboard', icon: BarChart3, priority: 'medium' },
  { id: 'mitarbeiter', label: 'Mitarbeiter', icon: Users, priority: 'low' },
  { id: 'dienstplan', label: 'Dienstplan', icon: FileSpreadsheet, priority: 'low' },
];

export const PageNavigation = () => {
  const [activeSection, setActiveSection] = useState<string>('');
  const [isVisible, setIsVisible] = useState(true);
  const [lastScrollY, setLastScrollY] = useState(0);
  const [isMobileOpen, setIsMobileOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      const currentScrollY = window.scrollY;
      
      // Hide nav when scrolling down, show when scrolling up
      if (currentScrollY > lastScrollY && currentScrollY > 200) {
        setIsVisible(false);
      } else {
        setIsVisible(true);
      }
      setLastScrollY(currentScrollY);

      // Update active section based on scroll position
      const sectionElements = sections.map(s => ({
        id: s.id,
        element: document.getElementById(s.id)
      })).filter(s => s.element);

      const current = sectionElements.find((s, index) => {
        const next = sectionElements[index + 1];
        const top = s.element!.offsetTop - 150;
        const bottom = next ? next.element!.offsetTop - 150 : Infinity;
        return currentScrollY >= top && currentScrollY < bottom;
      });

      if (current) {
        setActiveSection(current.id);
      }
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [lastScrollY]);

  const scrollToSection = (sectionId: string) => {
    const element = document.getElementById(sectionId);
    if (element) {
      const yOffset = -100;
      const y = element.getBoundingClientRect().top + window.pageYOffset + yOffset;
      window.scrollTo({ top: y, behavior: 'smooth' });
      setIsMobileOpen(false);
    }
  };

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <>
      {/* Mobile Navigation - Bottom Sheet Trigger */}
      <Sheet open={isMobileOpen} onOpenChange={setIsMobileOpen}>
        <SheetTrigger asChild>
          <Button
            variant="default"
            size="icon"
            className={cn(
              "lg:hidden fixed bottom-4 right-4 z-40 h-12 w-12 rounded-full shadow-lg transition-all duration-300",
              !isVisible && "translate-y-20 opacity-0"
            )}
          >
            <Menu className="h-5 w-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="bottom" className="h-auto max-h-[60vh]">
          <SheetHeader className="pb-4">
            <SheetTitle className="text-left">Navigation</SheetTitle>
          </SheetHeader>
          <div className="grid grid-cols-2 gap-2 pb-4">
            {sections.map((section) => {
              const Icon = section.icon;
              return (
                <button
                  key={section.id}
                  onClick={() => scrollToSection(section.id)}
                  className={cn(
                    "flex items-center gap-2 p-3 rounded-lg border text-left transition-colors",
                    activeSection === section.id
                      ? "bg-primary/10 border-primary text-primary"
                      : "hover:bg-muted",
                    section.priority === 'high' && "col-span-2"
                  )}
                >
                  <Icon className="h-4 w-4 flex-shrink-0" />
                  <span className="text-sm font-medium">{section.label}</span>
                </button>
              );
            })}
          </div>
          <Button
            variant="outline"
            className="w-full gap-2"
            onClick={scrollToTop}
          >
            <ChevronUp className="h-4 w-4" />
            Nach oben
          </Button>
        </SheetContent>
      </Sheet>

      {/* Scroll Progress Indicator */}
      <div className={cn(
        "fixed top-0 left-0 right-0 h-1 bg-muted z-50 transition-opacity duration-300",
        lastScrollY < 100 && "opacity-0"
      )}>
        <div 
          className="h-full bg-primary transition-all duration-150"
          style={{ 
            width: `${Math.min((lastScrollY / (document.body.scrollHeight - window.innerHeight)) * 100, 100)}%` 
          }}
        />
      </div>
    </>
  );
};
