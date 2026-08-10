export function jsonLog(module: string, event: string, fields: Record<string, unknown> = {}): void {
  // One physical line per record is intentional: dashboard and container collectors can parse it
  // without multiline framing rules.
  console.log(JSON.stringify({ ts: new Date().toISOString(), module, event, ...fields }));
}

/** Removes userinfo, query parameters, and fragments before an endpoint enters operational logs. */
export function publicEndpoint(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "<invalid-endpoint>";
  }
}

/** Formats an operational error while ensuring configured endpoint secrets cannot be repeated
 * by a lower-level exception message. Client errors should already use `publicEndpoint`; this is
 * the final log-boundary defense for native/custom fetch implementations. */
export function publicErrorMessage(error: unknown, endpoints: readonly string[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const endpoint of endpoints) {
    message = message.split(endpoint).join(publicEndpoint(endpoint));
  }
  return message;
}
