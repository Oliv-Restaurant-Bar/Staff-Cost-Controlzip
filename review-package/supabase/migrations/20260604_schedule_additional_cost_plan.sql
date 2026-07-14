-- Persistiert isAdditionalCostPlan direkt in schedule_entries.
-- Vorher wurde das Flag nur in localStorage gespeichert → ging nach Reload verloren.
ALTER TABLE schedule_entries
  ADD COLUMN IF NOT EXISTS is_additional_cost_plan BOOLEAN NOT NULL DEFAULT false;
