export function jsonLog(module: string, event: string, fields: Record<string, unknown> = {}): void {
  // One physical line per record is intentional: dashboard and container collectors can parse it
  // without multiline framing rules.
  console.log(JSON.stringify({ ts: new Date().toISOString(), module, event, ...fields }));
}

/** Removes userinfo, query parameters, and fragments before an endpoint enters operational logs. */
export function publicEndpoint(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}
