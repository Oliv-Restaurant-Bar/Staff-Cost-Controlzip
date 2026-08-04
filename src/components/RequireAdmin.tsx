/**
 * RequireAdmin — Zentraler Route-Guard für admin-only Flächen.
 * ============================================================
 * KEIN neues Berechtigungssystem — konsumiert ausschliesslich die bestehenden
 * usePermissions-Flags und spiegelt die seiteninternen Gates
 * (Defense-in-depth: die internen Gates bleiben).
 *
 *   allowBeaulieu → zusätzlich beaulieu_manager erlaubt (z.B. Kennzahlen-Bericht).
 */

import { Navigate } from 'react-router-dom';
import { usePermissions } from '@/hooks/usePermissions';

export const RequireAdmin = ({
  path,
  allowBeaulieu = false,
  redirectTo = '/',
  children,
}: {
  path: string;
  allowBeaulieu?: boolean;
  redirectTo?: string;
  children: JSX.Element;
}) => {
  const { isAdmin, isBeaulieuManager } = usePermissions();
  const ok = isAdmin || (allowBeaulieu && isBeaulieuManager);
  if (!ok) {
    console.log(`[AUTH] blocked route ${path} → redirect ${redirectTo}`);
    return <Navigate to={redirectTo} replace />;
  }
  return children;
};
