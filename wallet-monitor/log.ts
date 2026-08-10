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
  // Errors may normalize a configured URL (notably dropping its fragment) before echoing it, so
  // exact-string replacement alone is insufficient. Sanitize every HTTP/WS URL-shaped token at
  // the log boundary; public paths remain useful while userinfo, query, and fragments are removed.
  return message.replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/giu, (candidate) => publicEndpoint(candidate));
}

/** Returns a diagnostic cause whose own fields cannot retain a fetch implementation's private
 * URL. Do not attach the original error: `Error.cause` is directly inspectable even when the
 * outer operational message is safe. */
export function publicErrorCause(error: unknown, endpoints: readonly string[] = []): Error {
  return new Error(publicErrorMessage(error, endpoints));
}
