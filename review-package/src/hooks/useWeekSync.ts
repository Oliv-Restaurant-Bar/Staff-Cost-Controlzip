import { useState, useEffect, useCallback } from 'react';
import { startOfWeek, startOfMonth, getISOWeek, format } from 'date-fns';

const WEEK_SYNC_EVENT = 'week-sync-changed';
const WEEK_SYNC_KEY = 'current-synced-week';
const MONTH_SYNC_EVENT = 'month-sync-changed';
const MONTH_SYNC_KEY = 'current-synced-month';

interface WeekSyncData {
  weekStart: string; // ISO date string
  triggeredBy: string; // Component that triggered the change
}

interface MonthSyncData {
  monthStart: string; // ISO date string
  triggeredBy: string; // Component that triggered the change
}

/**
 * Hook for synchronizing week and month selection across all components.
 * When any component changes the week or month, all other components using this hook
 * will be notified and can update their view accordingly.
 */
export function useWeekSync(componentName: string, initialDate: Date) {
  const [currentWeekStart, setCurrentWeekStart] = useState(() => {
    // Check if there's a synced week in storage
    const saved = sessionStorage.getItem(WEEK_SYNC_KEY);
    if (saved) {
      try {
        const data: WeekSyncData = JSON.parse(saved);
        return new Date(data.weekStart);
      } catch {
        return startOfWeek(initialDate, { weekStartsOn: 1 });
      }
    }
    return startOfWeek(initialDate, { weekStartsOn: 1 });
  });

  const [currentMonthStart, setCurrentMonthStart] = useState(() => {
    // Check if there's a synced month in storage
    const saved = sessionStorage.getItem(MONTH_SYNC_KEY);
    if (saved) {
      try {
        const data: MonthSyncData = JSON.parse(saved);
        return new Date(data.monthStart);
      } catch {
        return startOfMonth(initialDate);
      }
    }
    return startOfMonth(initialDate);
  });

  // Listen for week changes from other components
  useEffect(() => {
    const handleWeekChange = (event: CustomEvent<WeekSyncData>) => {
      if (event.detail.triggeredBy !== componentName) {
        setCurrentWeekStart(new Date(event.detail.weekStart));
      }
    };

    window.addEventListener(WEEK_SYNC_EVENT, handleWeekChange as EventListener);
    return () => {
      window.removeEventListener(WEEK_SYNC_EVENT, handleWeekChange as EventListener);
    };
  }, [componentName]);

  // Listen for month changes from other components
  useEffect(() => {
    const handleMonthChange = (event: CustomEvent<MonthSyncData>) => {
      if (event.detail.triggeredBy !== componentName) {
        setCurrentMonthStart(new Date(event.detail.monthStart));
      }
    };

    window.addEventListener(MONTH_SYNC_EVENT, handleMonthChange as EventListener);
    return () => {
      window.removeEventListener(MONTH_SYNC_EVENT, handleMonthChange as EventListener);
    };
  }, [componentName]);

  // Function to broadcast week changes to other components
  const broadcastWeekChange = useCallback((weekStart: Date, source: string) => {
    const data: WeekSyncData = {
      weekStart: weekStart.toISOString(),
      triggeredBy: source,
    };
    
    // Store in session storage for persistence during page navigation
    sessionStorage.setItem(WEEK_SYNC_KEY, JSON.stringify(data));
    
    // Dispatch event for immediate updates
    window.dispatchEvent(new CustomEvent(WEEK_SYNC_EVENT, { detail: data }));
  }, []);

  // Function to broadcast month changes to other components
  const broadcastMonthChange = useCallback((monthStart: Date, source: string) => {
    const data: MonthSyncData = {
      monthStart: monthStart.toISOString(),
      triggeredBy: source,
    };
    
    // Store in session storage for persistence during page navigation
    sessionStorage.setItem(MONTH_SYNC_KEY, JSON.stringify(data));
    
    // Dispatch event for immediate updates
    window.dispatchEvent(new CustomEvent(MONTH_SYNC_EVENT, { detail: data }));
  }, []);

  // Update local state when initialDate changes (e.g., from DateSelector)
  useEffect(() => {
    const newWeekStart = startOfWeek(initialDate, { weekStartsOn: 1 });
    const newMonthStart = startOfMonth(initialDate);
    
    // Always update when initialDate changes
    setCurrentWeekStart(newWeekStart);
    setCurrentMonthStart(newMonthStart);
    
    // Broadcast the changes so all components sync
    broadcastWeekChange(newWeekStart, componentName);
    broadcastMonthChange(newMonthStart, componentName);
  }, [initialDate, componentName, broadcastWeekChange, broadcastMonthChange]);

  // Function to change the week and notify other components
  const setWeek = useCallback((newWeekStart: Date) => {
    const weekStart = startOfWeek(newWeekStart, { weekStartsOn: 1 });
    setCurrentWeekStart(weekStart);
    broadcastWeekChange(weekStart, componentName);
    
    // Also update month if week is in a different month
    const newMonthStart = startOfMonth(weekStart);
    if (newMonthStart.getTime() !== currentMonthStart.getTime()) {
      setCurrentMonthStart(newMonthStart);
      broadcastMonthChange(newMonthStart, componentName);
    }
  }, [componentName, broadcastWeekChange, broadcastMonthChange, currentMonthStart]);

  // Function to change the month and notify other components
  const setMonth = useCallback((newDate: Date) => {
    const monthStart = startOfMonth(newDate);
    setCurrentMonthStart(monthStart);
    broadcastMonthChange(monthStart, componentName);
    
    // Also update week to the first week of the new month
    const newWeekStart = startOfWeek(monthStart, { weekStartsOn: 1 });
    setCurrentWeekStart(newWeekStart);
    broadcastWeekChange(newWeekStart, componentName);
  }, [componentName, broadcastWeekChange, broadcastMonthChange]);

  // Navigate to previous/next week
  const navigateWeek = useCallback((direction: 'prev' | 'next') => {
    const newWeekStart = new Date(currentWeekStart);
    newWeekStart.setDate(newWeekStart.getDate() + (direction === 'prev' ? -7 : 7));
    setWeek(newWeekStart);
  }, [currentWeekStart, setWeek]);

  // Navigate to previous/next month
  const navigateMonth = useCallback((direction: 'prev' | 'next') => {
    const newMonthStart = new Date(currentMonthStart);
    newMonthStart.setMonth(newMonthStart.getMonth() + (direction === 'prev' ? -1 : 1));
    setMonth(newMonthStart);
  }, [currentMonthStart, setMonth]);

  // Get current week number
  const weekNumber = getISOWeek(currentWeekStart);

  // Get formatted week range
  const weekRange = `KW ${weekNumber}`;

  // Get formatted month
  const monthLabel = format(currentMonthStart, 'MMMM yyyy');

  return {
    currentWeekStart,
    currentMonthStart,
    setWeek,
    setMonth,
    navigateWeek,
    navigateMonth,
    weekNumber,
    weekRange,
    monthLabel,
  };
}

// Utility to get week number from a date
export function getWeekNumber(date: Date): number {
  return getISOWeek(date);
}
