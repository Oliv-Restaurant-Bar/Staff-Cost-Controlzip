/**
 * RequireAdmin — Zentraler Route-Guard für admin-only Flächen.
 * ============================================================
 * KEIN neues Berechtigungssystem — konsumiert ausschliesslich die bestehenden
 * usePermissions-Flags und spiegelt die seiteninternen Gates
 * (Defense-in-depth: die internen Gates bleiben).
 *
 *   allowGuest=true  → Gast-Sessions (isAdmin schliesst Gäste ein) dürfen lesen.
 *   allowGuest=false → PII-/Schreibflächen: Gäste explizit ausgeschlossen.
 *   allowBeaulieu    → zusätzlich beaulieu_manager erlaubt (z.B. Kennzahlen-Bericht).
 */

import { Navigate } from 'react-router-dom';
import { usePermissions } from '@/hooks/usePermissions';

export const RequireAdmin = ({
  path,
  allowGuest = true,
  allowBeaulieu = false,
  redirectTo = '/',
  children,
}: {
  path: string;
  allowGuest?: boolean;
  allowBeaulieu?: boolean;
  redirectTo?: string;
  children: JSX.Element;
}) => {
  const { isAdmin, isGuest, isBeaulieuManager } = usePermissions();
  const adminOk = allowGuest ? isAdmin : (isAdmin && !isGuest);
  const ok = adminOk || (allowBeaulieu && isBeaulieuManager);
  if (!ok) {
    console.log(`[AUTH] blocked route ${path} → redirect ${redirectTo}`);
    return <Navigate to={redirectTo} replace />;
  }
  return children;
};
