import { errorMessage } from "@crane/contracts";
import { useState } from "react";
import { isSignedOut } from "./auth.js";
import { useToast, type ToastMessage } from "./toast.js";

/** What to say when an action succeeds: fixed text, or a toast built from its result. Returning nothing says nothing. */
export type ActionDone<R> = string | ((result: R) => ToastMessage | undefined);

export interface ActionEffects {
  setBusy: (key: string | null) => void;
  toast: (toast: ToastMessage) => void;
  refresh?: () => void;
}

export interface ActionStep<R> {
  key: string;
  action: () => Promise<R>;
  done?: ActionDone<R>;
  after?: (result: R) => void;
}

function doneToast<R>(done: ActionDone<R> | undefined, result: R): ToastMessage | undefined {
  if (typeof done === "function") return done(result);
  return done === undefined ? undefined : { text: done };
}

/** Mark busy, run the action, say how it went and refresh. A failure is shown as a toast, never thrown. */
export async function runAction<R>(effects: ActionEffects, step: ActionStep<R>): Promise<void> {
  effects.setBusy(step.key);
  try {
    const result = await step.action();
    const message = doneToast(step.done, result);
    if (message) effects.toast(message);
    effects.refresh?.();
    step.after?.(result);
  } catch (e) {
    // Signed out: the app is already returning to sign-in, which says so better than a toast.
    if (!isSignedOut(e)) effects.toast({ text: errorMessage(e) });
  } finally {
    effects.setBusy(null);
  }
}

/**
 * Runs operator actions the same way: `busy` holds the key of the one in
 * progress, the outcome shows as a toast, and `refresh` follows a success.
 */
export function useAction(refresh?: () => void) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = <R>(key: string, action: () => Promise<R>, done?: ActionDone<R>, after?: (result: R) => void) =>
    runAction({ setBusy, toast, refresh }, { key, action, done, after });
  return { busy, run };
}
