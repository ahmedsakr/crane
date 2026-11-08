import { readFileSync } from "node:fs";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { createServer, type ServerOptions } from "node:https";
import { createSecureContext } from "node:tls";
import { errorMessage } from "@crane/contracts";

export interface TlsOptions {
  tlsCert?: string;
  tlsKey?: string;
}

function readTlsFile(path: string, flag: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    throw new Error(`Couldn't read ${flag} file "${path}": ${errorMessage(error)}`);
  }
}

/** Read and validate once at startup, before a build or factory work. Renewal requires a restart. */
export function loadTls(options: TlsOptions): { createServer: typeof createServer; serverOptions: ServerOptions } | undefined {
  const { tlsCert, tlsKey } = options;
  if (tlsCert === undefined && tlsKey === undefined) return undefined;
  if (tlsCert === undefined || tlsKey === undefined) {
    throw new Error("--tls-cert <file> and --tls-key <file> must be given together.");
  }
  const cert = readTlsFile(tlsCert, "--tls-cert");
  const key = readTlsFile(tlsKey, "--tls-key");
  try {
    new X509Certificate(cert);
    createPrivateKey(key);
    createSecureContext({ cert, key });
  } catch (error) {
    throw new Error(`Invalid TLS certificate "${tlsCert}" or key "${tlsKey}": ${errorMessage(error)}`);
  }
  return { createServer, serverOptions: { cert, key } };
}
