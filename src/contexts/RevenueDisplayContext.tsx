import { createContext, useContext, ReactNode } from 'react';

interface RevenueDisplayContextType {
  showNetRevenue: boolean;
  setShowNetRevenue: (value: boolean) => void;
}

const RevenueDisplayContext = createContext<RevenueDisplayContextType | undefined>(undefined);

export const RevenueDisplayProvider = ({ children }: { children: ReactNode }) => {
  return (
    <RevenueDisplayContext.Provider value={{ showNetRevenue: true, setShowNetRevenue: () => {} }}>
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
