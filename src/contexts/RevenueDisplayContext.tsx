import { createContext, useContext, useState, useEffect, ReactNode } from 'react';

const STORAGE_KEY = 'revenue-display-mode';

interface RevenueDisplayContextType {
  showNetRevenue: boolean;
  setShowNetRevenue: (value: boolean) => void;
}

const RevenueDisplayContext = createContext<RevenueDisplayContextType | undefined>(undefined);

export const RevenueDisplayProvider = ({ children }: { children: ReactNode }) => {
  const [showNetRevenue, setShowNetRevenueState] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved !== 'brutto'; // default: netto (nur explizit 'brutto' schaltet um)
  });

  // Persist to localStorage whenever the value changes
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, showNetRevenue ? 'netto' : 'brutto');
  }, [showNetRevenue]);

  const setShowNetRevenue = (value: boolean) => {
    setShowNetRevenueState(value);
  };

  return (
    <RevenueDisplayContext.Provider value={{ showNetRevenue, setShowNetRevenue }}>
      {children}
    </RevenueDisplayContext.Provider>
  );
};

export const useRevenueDisplay = (): RevenueDisplayContextType => {
  const context = useContext(RevenueDisplayContext);
  if (!context) {
    throw new Error('useRevenueDisplay must be used within a RevenueDisplayProvider');
  }
  return context;
};
