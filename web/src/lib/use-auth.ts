import { useSyncExternalStore } from "react";
import { api } from "./api";
import { createAuthStore, onSignInRequired } from "./auth";

/** The app's one session store. Any call the gate refuses marks it signed out. */
export const authStore = createAuthStore({ session: api.session, signOut: api.signOut });
onSignInRequired(() => authStore.refused());

/** Who is signed in on this device, and whether sign-in is required at all. `status` is null until the first answer. */
export function useAuth() {
  const { status, error } = useSyncExternalStore(authStore.subscribe, authStore.get);
  return {
    status,
    error,
    operator: status?.operator ?? null,
    refresh: authStore.refresh,
    signOut: authStore.signOut,
    setOperator: authStore.setOperator,
  };
}
