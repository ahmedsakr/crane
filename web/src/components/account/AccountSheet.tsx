import { useCallback, useEffect, useState } from "react";
import { errorMessage, type OperatorSession } from "@crane/contracts";
import { api } from "../../lib/api";
import { isSignedOut } from "../../lib/auth";
import { useToast } from "../../lib/toast";
import { useAuth } from "../../lib/use-auth";
import { Sheet } from "../Sheet";
import { AccountSummary } from "./AccountSummary";
import { DeviceList, type DeviceActions } from "./DeviceList";
import { PasswordForm } from "./PasswordForm";

type View = "summary" | "devices" | "password";

/** This operator's devices, loaded when the sheet opens and replaced by whatever each sign-out answers. */
function useMySessions() {
  const [sessions, setSessions] = useState<OperatorSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    api.mySessions().then(
      (list) => { setSessions(list); setError(null); },
      (e: unknown) => !isSignedOut(e) && setError(`Couldn't load devices: ${errorMessage(e)}`),
    );
  }, []);
  useEffect(reload, [reload]);
  return { sessions, setSessions, error, reload };
}

/** The signed-in operator's own account: name, devices and password, in one sheet whose contents swap. */
export function AccountSheet({ onClose }: { onClose: () => void }) {
  const { operator, refresh, setOperator } = useAuth();
  const toast = useToast();
  const [view, setView] = useState<View>("summary");
  const { sessions, setSessions, error, reload } = useMySessions();
  const back = view === "summary" ? undefined : () => setView("summary");
  if (!operator) return null;
  const devices: DeviceActions = {
    async signOut(session) {
      const left = await api.signOutMySession(session.id);
      // This device's session is gone; asking again shows the sign-in screen.
      if (session.current) return void (await refresh());
      setSessions(left);
    },
    async signOutOthers() {
      setSessions(await api.signOutMyOtherSessions());
    },
  };
  const content = () => {
    if (view === "devices") return <DeviceList sessions={sessions} error={error} actions={devices} onBack={back!} />;
    if (view === "password") {
      return <PasswordForm username={operator.username} onBack={back!} onChanged={() => {
        toast({ text: "Password changed. Your other devices are signed out." });
        reload();
        setView("summary");
      }} />;
    }
    return <AccountSummary operator={operator} sessions={sessions} onRenamed={setOperator}
      onDevices={() => setView("devices")} onPassword={() => setView("password")} />;
  };
  return <Sheet onClose={onClose} onDismiss={back ?? onClose} view={view}>{content()}</Sheet>;
}
