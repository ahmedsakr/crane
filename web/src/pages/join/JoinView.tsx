import { Mark } from "../../components/Mark";
import { invitedAs } from "../../lib/operators";
import { JoinForm, type JoinInput } from "./JoinForm";
import type { InviteState } from "./use-invite";

export function JoinView({ state, onRetry, onAccept, onInvalid }: {
  state: InviteState; onRetry: () => void; onAccept: (input: JoinInput) => Promise<void>; onInvalid: () => void;
}) {
  const title = state.kind === "ready" && state.invite.kind === "reset" ? `Set a new password for ${state.invite.username}` : "Join Crane";
  return (
    <main className="sign-in">
      <div className="sign-in-card join-card">
        <Mark size={44} />
        <h1 className="sign-in-title">{title}</h1>
        {state.kind === "loading" && <p className="muted" role="status">Checking your link…</p>}
        {state.kind === "error" && <>
          <p className="sign-in-error" role="alert">{state.message}</p>
          {!state.invalid && <button type="button" className="btn btn-quiet" onClick={onRetry}>Try again</button>}
        </>}
        {state.kind === "ready" && <>
          {state.invite.kind === "join" && <p className="sign-in-note muted">{invitedAs(state.invite)}</p>}
          <JoinForm invite={state.invite} onAccept={onAccept} onInvalid={onInvalid} />
        </>}
      </div>
    </main>
  );
}
