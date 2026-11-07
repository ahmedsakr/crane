import { useEffect, useRef, useState } from "react";
import type { InviteCheck } from "@crane/contracts";
import { api } from "../../lib/api";
import { INVALID_LINK, inviteChecker, linkFailure, takeInviteToken } from "../../lib/join";

export type InviteState = { kind: "loading" } | { kind: "ready"; invite: InviteCheck }
  | { kind: "error"; invalid: boolean; message: string };

/** The secret survives effect replay, but leaves memory when this page unmounts. */
export function useInvite() {
  const entry = useRef<{ token: string; check: ReturnType<typeof inviteChecker> } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<InviteState>({ kind: "loading" });
  useEffect(() => {
    if (!entry.current) {
      const token = takeInviteToken(window.location, window.history);
      entry.current = { token, check: inviteChecker(token, api.checkInvite) };
    }
    if (!entry.current.token) {
      setState({ kind: "error", invalid: true, message: INVALID_LINK });
      return;
    }
    let live = true;
    setState({ kind: "loading" });
    entry.current.check(attempt > 0).then(
      (invite) => live && setState({ kind: "ready", invite }),
      (error: unknown) => live && setState({ kind: "error", ...linkFailure(error) }),
    );
    return () => { live = false; };
  }, [attempt]);
  return {
    state,
    token: entry.current?.token ?? "",
    retry: () => setAttempt((n) => n + 1),
    invalidate: () => setState({ kind: "error", invalid: true, message: INVALID_LINK }),
  };
}
