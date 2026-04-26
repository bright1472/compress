import { isLoggedIn } from './useAuth';
import { canCompress } from './useUsageLimit';

export function checkAndGate(openAuth: (fromGate?: boolean) => void, openActivation: () => void): boolean {
  if (canCompress.value) return true;
  isLoggedIn.value ? openActivation() : openAuth(true);
  return false;
}
