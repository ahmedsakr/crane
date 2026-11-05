import { errorMessage } from "@crane/contracts";
import { useState } from "react";

/**
 * Runs a form's submit: `busy` while it's in flight, and a failure stays in `error`
 * for the form to show beside its button rather than as a toast.
 */
export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}
