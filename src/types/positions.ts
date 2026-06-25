import type { Department } from '@/types/personnel';

/**
 * Position — konfigurierbare Positions-/Stationsstammdaten (Personalbedarf-Grundlage).
 *
 * Eine Position gehört zu genau einer Abteilung (service | küche) und wird je
 * Mandant verwaltet. `key` ist ein STABILER Schlüssel (Slug): Mitarbeitende
 * speichern diesen Schlüssel als Haupt-/Zweitposition, damit der Anzeigename
 * (`name`) später geändert werden kann, ohne Zuordnungen zu zerstören.
 *
 * DB-Tabelle: `positions` (siehe supabase/migrations/20260625_positions.sql).
 */
export interface Position {
  id: string;
  restaurantId: string;
  /** Stabiler, je Mandant eindeutiger Schlüssel (z.B. "chef_de_rang"). */
  key: string;
  /** Anzeigename (z.B. "Chef de Rang"). Darf umbenannt werden. */
  name: string;
  department: Department;
  /** Optionale feinere Gruppierung innerhalb der Abteilung (z.B. "Bar", "Warm"). */
  departmentGroup?: string;
  /** Hex-Farbe für Badges/Chips (z.B. "#3b82f6"). */
  color?: string;
  /** Lucide-Icon-Name (z.B. "ChefHat"). */
  icon?: string;
  sortOrder: number;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** Felder, die beim Anlegen einer Position (vor DB-Insert) gesetzt werden. */
export type PositionDraft = Omit<Position, 'id' | 'restaurantId' | 'createdAt' | 'updatedAt'>;
