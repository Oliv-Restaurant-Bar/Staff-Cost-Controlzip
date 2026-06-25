/**
 * PositionIcon — rendert ein Lucide-Icon anhand seines Namens (string).
 * Begrenzt auf die kuratierte Icon-Liste (POSITION_ICONS), damit der Bundle
 * nicht das gesamte lucide-Paket zieht. Fallback: Circle.
 */
import {
  ChefHat, Utensils, UtensilsCrossed, Pizza, Soup, Beef,
  Wine, Beer, Coffee, GlassWater, CakeSlice, Salad,
  Users, User, UserCheck, ConciergeBell, Bell, Sparkles,
  Flame, Refrigerator, Brush, Star, Circle,
  type LucideIcon,
} from 'lucide-react';

const ICON_MAP: Record<string, LucideIcon> = {
  ChefHat, Utensils, UtensilsCrossed, Pizza, Soup, Beef,
  Wine, Beer, Coffee, GlassWater, CakeSlice, Salad,
  Users, User, UserCheck, ConciergeBell, Bell, Sparkles,
  Flame, Refrigerator, Brush, Star,
};

export function PositionIcon({ name, className }: { name?: string; className?: string }) {
  const Icon = (name && ICON_MAP[name]) || Circle;
  return <Icon className={className} />;
}
