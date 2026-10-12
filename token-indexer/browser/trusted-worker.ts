/**
 * The Trusted Types policy of the static build's pages. Their Content-Security-Policy requires Trusted Types for script
 * sinks (`require-trusted-types-for 'script'`) and allows exactly one policy, {@link ENGINE_WORKER_POLICY}
 * (`trusted-types umbradb-engine-worker`). A `Worker` constructor given a plain string or `URL` therefore throws; the
 * page creates the engine's worker through this policy, which accepts only a script URL of the page's origin inside
 * the directory this module was loaded from (the build's `assets/`, or the dev server's root).
 *
 * Every other HTML or script sink (`innerHTML`, `eval`, `setTimeout(string)`, …) has no policy and stays refused.
 */

/** The name of the one Trusted Types policy the pages' CSP allows. */
export const ENGINE_WORKER_POLICY = "umbradb-engine-worker";

/** The part of the Trusted Types API this module uses (the TypeScript DOM library does not declare it). */
interface TrustedScriptUrlPolicy {
  createScriptURL(input: string): unknown;
}
interface TrustedTypesFactory {
  createPolicy(name: string, rules: { createScriptURL(input: string): string }): TrustedScriptUrlPolicy;
}

/**
 * The script URL `input` as an absolute URL, if it is a worker script this page may start: the same origin as the page
 * and a path inside the directory of `moduleUrl`. Throws a `TypeError` otherwise.
 */
export function checkWorkerScriptUrl(input: string, moduleUrl: string, pageOrigin: string): string {
  let url: URL;
  try {
    url = new URL(input, moduleUrl);
  } catch {
    throw new TypeError(`${ENGINE_WORKER_POLICY}: ${JSON.stringify(input)} is not a URL`);
  }
  const dir = new URL(".", moduleUrl);
  if (url.origin !== pageOrigin || dir.origin !== pageOrigin) throw new TypeError(`${ENGINE_WORKER_POLICY}: ${url.origin} is not this page's origin`);
  if (!url.pathname.startsWith(dir.pathname)) throw new TypeError(`${ENGINE_WORKER_POLICY}: ${url.pathname} is outside ${dir.pathname}`);
  return url.href;
}

let policy: TrustedScriptUrlPolicy | undefined;

/**
 * The `Worker` constructor to start the engine's worker with: where the browser has Trusted Types, a subclass that
 * passes its script URL through the {@link ENGINE_WORKER_POLICY} policy (created once per page); elsewhere `Worker`.
 */
export function trustedWorkerConstructor(): typeof Worker {
  const factory = (globalThis as { trustedTypes?: TrustedTypesFactory }).trustedTypes;
  if (factory === undefined) return Worker;
  policy ??= factory.createPolicy(ENGINE_WORKER_POLICY, {
    createScriptURL: (input) => checkWorkerScriptUrl(input, import.meta.url, globalThis.location.origin),
  });
  const trusted = policy;
  return class TrustedWorker extends Worker {
    constructor(scriptUrl: string | URL, options?: WorkerOptions) {
      super(trusted.createScriptURL(String(scriptUrl)) as string, options);
    }
  };
}
