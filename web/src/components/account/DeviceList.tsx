import { useState } from "react";
import { errorMessage, type OperatorSession } from "@crane/contracts";
import { deviceDetail, deviceName, devicesLabel, orderSessions } from "../../lib/account";
import { isSignedOut } from "../../lib/auth";
import { SheetBody, SheetFoot, SheetHead } from "../Sheet";

export interface DeviceActions {
  /** Signs out one device. Signing out this one ends this session, and the app returns to sign-in. */
  signOut: (session: OperatorSession) => Promise<void>;
  signOutOthers: () => Promise<void>;
}

function DeviceRow({ session, busy, onSignOut }: { session: OperatorSession; busy: boolean; onSignOut: () => void }) {
  const name = deviceName(session);
  return (
    <li className="account-device">
      <div className="account-device-text">
        <span className="account-device-name">
          {name}
          {session.current && <span className="chip">This device</span>}
        </span>
        <small className="muted">{deviceDetail(session)}</small>
      </div>
      <button type="button" className="btn btn-quiet btn-sm" disabled={busy} onClick={onSignOut}
        aria-label={session.current ? "Sign out this device" : `Sign out ${name}`}>
        Sign out
      </button>
    </li>
  );
}

/** Every device signed in as this operator, this one first, each one tap from signed out. */
export function DeviceList({ sessions, error, actions, onBack }: {
  sessions: OperatorSession[] | null;
  /** Why the list couldn't load. */
  error: string | null;
  actions: DeviceActions;
  onBack: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setFailure(null);
    try {
      await action();
    } catch (e) {
      if (!isSignedOut(e)) setFailure(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const ordered = orderSessions(sessions ?? []);
  const others = ordered.filter((s) => !s.current).length;
  const message = failure ?? error;
  return (
    <>
      <SheetHead onBack={onBack} title="Devices" subtitle={sessions ? devicesLabel(sessions.length) : "Loading…"} />
      <SheetBody>
        <ul className="account-devices" aria-label="Signed-in devices">
          {ordered.map((s) => <DeviceRow key={s.id} session={s} busy={busy} onSignOut={() => void run(() => actions.signOut(s))} />)}
        </ul>
      </SheetBody>
      <SheetFoot note={message ? <span role="alert" className="error-text">{message}</span> : undefined}>
        <button type="button" className="btn btn-quiet" disabled={busy || others === 0} onClick={() => void run(actions.signOutOthers)}>
          Sign out other devices
        </button>
      </SheetFoot>
    </>
  );
}
