import { createContext, useContext, useState, useEffect, ReactNode } from 'react';

const STORAGE_KEY = 'plan-display-mode';

interface PlanDisplayContextType {
  showPlannedData: boolean;
  setShowPlannedData: (value: boolean) => void;
}

const PlanDisplayContext = createContext<PlanDisplayContextType | undefined>(undefined);

export const PlanDisplayProvider = ({ children }: { children: ReactNode }) => {
  const [showPlannedData, setShowPlannedDataState] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved !== 'hidden'; // default: show planned data
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, showPlannedData ? 'visible' : 'hidden');
  }, [showPlannedData]);

  return (
    <PlanDisplayContext.Provider value={{ showPlannedData, setShowPlannedData: setShowPlannedDataState }}>
      {children}
    </PlanDisplayContext.Provider>
  );
};

export const usePlanDisplay = (): PlanDisplayContextType => {
  const context = useContext(PlanDisplayContext);
  if (!context) {
    throw new Error('usePlanDisplay must be used within a PlanDisplayProvider');
  }
  return context;
};
