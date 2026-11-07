import type { InviteCheck, InviteSummary, OperatorSummary } from "@crane/contracts";
import { ROLE_LABEL } from "./auth";
import { ago } from "./format";

/** Only issuing a link returns its secret. List responses contain InviteSummary alone. */
export interface InviteLink {
  invite: InviteSummary;
  token: string;
  path: string;
}

export const absoluteInviteLink = (origin: string, path: string): string => origin + path;

export const operatorSeen = (operator: OperatorSummary): string =>
  operator.lastSeenAt ? `Last seen ${ago(operator.lastSeenAt)}` : "No devices signed in";

export function pendingLinkLabel(invite: InviteSummary): string {
  if (invite.kind === "reset") return `Password reset for ${invite.forOperator?.username ?? "operator"}`;
  return `${invite.name || "New operator"} · ${ROLE_LABEL[invite.role ?? "operator"]}`;
}

export function invitedAs(invite: InviteCheck): string {
  const role = invite.role ?? "operator";
  const article = role === "admin" ? "an admin" : "an operator";
  return `${invite.invitedBy || "An admin"} invited you as ${article}`;
}
