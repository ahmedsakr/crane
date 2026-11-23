import type { MiddlewareHandler } from "hono";
import { AccessError } from "@crane/factory/actions";
import type { RunnerRecord } from "@crane/storage";
import type { ApiAccess } from "./auth.js";
import { AttemptLimiter } from "./sign-in-limit.js";

declare module "hono" {
  interface ContextVariableMap {
    runner: RunnerRecord;
  }
}

export const isRunnerPath = (path: string): boolean => path === "/api/runner" || path.startsWith("/api/runner/");

/** Container authentication has its own limiter and never establishes an operator actor. */
export function requireRunner({ actions, now, clientKey }: ApiAccess): MiddlewareHandler {
  const limiter = new AttemptLimiter(now);
  return async (c, next) => {
    c.header("cache-control", "no-store");
    const token = /^Bearer +([A-Za-z0-9_-]+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
    const runner = await limiter.attempt([limiter.limit("client", clientKey(c))], async () => {
      const authenticated = actions.authenticateRunner(token);
      if (!authenticated) {
        c.header("www-authenticate", "Bearer");
        throw new AccessError(401, "Unauthorized");
      }
      return authenticated;
    }, (err) => err instanceof AccessError && err.status === 401);
    c.set("runner", runner);
    await next();
  };
}
