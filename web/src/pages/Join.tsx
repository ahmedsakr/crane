import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useToast } from "../lib/toast";
import { authStore } from "../lib/use-auth";
import { JoinView } from "./join/JoinView";
import { useInvite } from "./join/use-invite";

/** Public, outside the session gate: a link itself grants permission to join or reset a password. */
export function Join() {
  const { state, token, retry, invalidate } = useInvite();
  const navigate = useNavigate();
  const toast = useToast();
  return <JoinView state={state} onRetry={retry} onInvalid={invalidate} onAccept={async (input) => {
    const status = await api.acceptInvite(token, input);
    authStore.set(status);
    navigate("/", { replace: true });
    toast({ text: `Welcome, ${status.operator?.name ?? "operator"}.` });
  }} />;
}
