import type { OperatorProfile, OperatorSession } from "@crane/contracts";
import { deviceName, devicesLabel } from "../../lib/account";
import { ROLE_LABEL } from "../../lib/auth";
import { Chevron } from "../Chevron";
import { SheetBody, SheetHead } from "../Sheet";
import { NameEditor } from "./NameEditor";

/** What the sheet opens on: who this is and how many devices are signed in. Devices and password are a tap away. */
export function AccountSummary({ operator, sessions, onRenamed, onDevices, onPassword }: {
  operator: OperatorProfile;
  sessions: OperatorSession[] | null;
  onRenamed: (operator: OperatorProfile) => void;
  onDevices: () => void;
  onPassword: () => void;
}) {
  const here = sessions?.find((s) => s.current);
  return (
    <>
      <SheetHead title="Your account" />
      <SheetBody>
        <section className="account-who" aria-label="Profile">
          <NameEditor operator={operator} onRenamed={onRenamed} />
          <p className="account-role">
            {ROLE_LABEL[operator.role]} · <span className="mono">{operator.username}</span>
          </p>
        </section>
        <div className="account-links">
          <button type="button" className="sheet-link account-link" onClick={onDevices}>
            <span className="account-link-text">
              <span>{sessions ? devicesLabel(sessions.length) : "Devices"}</span>
              {here && <small className="muted">This device: {deviceName(here)}</small>}
            </span>
            <Chevron />
          </button>
          <button type="button" className="sheet-link account-link" onClick={onPassword}>
            <span>Change password</span>
            <Chevron />
          </button>
        </div>
      </SheetBody>
    </>
  );
}
