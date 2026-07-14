import { BarChart3, Euro, Users, CalendarDays } from 'lucide-react';
import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';

export type MainTab = 'übersicht' | 'umsatz' | 'personal' | 'dienstplan';

interface MainTabNavigationProps {
  activeTab: MainTab;
  onTabChange: (tab: MainTab) => void;
}

const tabs = [
  { id: 'übersicht' as MainTab, label: 'Übersicht', shortLabel: 'KPIs', tinyLabel: '', icon: BarChart3 },
  { id: 'umsatz' as MainTab, label: 'Umsatz', shortLabel: '€', tinyLabel: '', icon: Euro },
  { id: 'personal' as MainTab, label: 'Personal', shortLabel: 'Team', tinyLabel: '', icon: Users },
  { id: 'dienstplan' as MainTab, label: 'Dienstplan', shortLabel: 'Plan', tinyLabel: '', icon: CalendarDays },
];

export const MainTabNavigation = ({ activeTab, onTabChange }: MainTabNavigationProps) => {
  return (
    <div className="w-full bg-gradient-to-b from-background to-muted/30 border-b border-border/50">
      <div className="container mx-auto px-4">
        <nav className="relative flex h-14">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            
            return (
              <button
                key={tab.id}
                onClick={() => onTabChange(tab.id)}
                className={cn(
                  "relative flex-1 flex items-center justify-center gap-1.5 sm:gap-2 px-2 sm:px-4 py-3",
                  "text-sm font-medium transition-all duration-300",
                  "hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  "hover:bg-primary/5 hover:shadow-[0_0_20px_rgba(var(--primary-rgb),0.15)]",
                  "rounded-t-lg min-w-0",
                  isActive 
                    ? "text-foreground" 
                    : "text-muted-foreground hover:text-foreground/80"
                )}
              >
                {/* Active background glow */}
                {isActive && (
                  <motion.div
                    layoutId="activeTabBg"
                    className="absolute inset-0 bg-primary/5 rounded-t-lg"
                    initial={false}
                    transition={{
                      type: "spring",
                      stiffness: 500,
                      damping: 35,
                    }}
                  />
                )}
                
                {/* Icon with animation */}
                <motion.div
                  animate={{
                    scale: isActive ? 1.1 : 1,
                    rotate: isActive ? [0, -5, 5, 0] : 0,
                  }}
                  transition={{
                    scale: { duration: 0.2 },
                    rotate: { duration: 0.3, delay: 0.1 },
                  }}
                  className="shrink-0"
                >
                  <Icon className={cn(
                    "h-4 w-4 transition-colors duration-200",
                    isActive ? "text-primary" : "text-muted-foreground"
                  )} />
                </motion.div>
                
                {/* Label - hidden on tiny screens, short on small, full on medium+ */}
                <span className="relative z-10 text-xs sm:text-sm truncate">
                  <span className="hidden sm:inline">{tab.label}</span>
                  <span className="sm:hidden">{tab.shortLabel}</span>
                </span>
                
                {/* Active indicator line */}
                {isActive && (
                  <motion.div
                    layoutId="activeTabIndicator"
                    className="absolute bottom-0 left-2 right-2 h-0.5 bg-gradient-to-r from-primary/50 via-primary to-primary/50 rounded-full"
                    initial={false}
                    transition={{
                      type: "spring",
                      stiffness: 500,
                      damping: 35,
                    }}
                  />
                )}
              </button>
            );
          })}
          
          {/* Decorative bottom border gradient */}
          <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-border to-transparent" />
        </nav>
      </div>
    </div>
  );
};
