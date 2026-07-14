import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface CapacitySettings {
  mittag_capacity: number;
  abend_capacity: number;
  u1_capacity: number;
  u1_days: number[]; // 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
}

const DEFAULTS: CapacitySettings = {
  mittag_capacity: 80,
  abend_capacity: 80,
  u1_capacity: 80,
  u1_days: [5, 6],
};

export const useCapacitySettings = () => {
  const [settings, setSettings] = useState<CapacitySettings>(DEFAULTS);
  const [loading, setLoading] = useState(true);

  const fetchSettings = async () => {
    const { data, error } = await supabase
      .from('capacity_settings')
      .select('*')
      .eq('id', 'default')
      .single();

    if (!error && data) {
      setSettings({
        mittag_capacity: data.mittag_capacity,
        abend_capacity: data.abend_capacity,
        u1_capacity: data.u1_capacity,
        u1_days: data.u1_days,
      });
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchSettings();
  }, []);

  const updateSettings = async (newSettings: Partial<CapacitySettings>) => {
    const updated = { ...settings, ...newSettings, updated_at: new Date().toISOString() };
    const { error } = await supabase
      .from('capacity_settings')
      .update(updated)
      .eq('id', 'default');

    if (!error) {
      setSettings({ ...settings, ...newSettings });
      return true;
    }
    return false;
  };

  const getAbendCapacity = (day: Date) => {
    const dow = day.getDay(); // 0=Sun...6=Sat
    return settings.u1_days.includes(dow)
      ? settings.abend_capacity + settings.u1_capacity
      : settings.abend_capacity;
  };

  return { settings, loading, updateSettings, getAbendCapacity, refetch: fetchSettings };
};
