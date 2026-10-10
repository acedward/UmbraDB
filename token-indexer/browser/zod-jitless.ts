/**
 * Turns zod's JIT off before any schema exists. zod compiles object parsers with `new Function` and, unless `jitless`
 * is set, probes for it with `new Function("")` when an object schema is created; under the static build's
 * Content-Security-Policy (no `'unsafe-eval'`) the probe is refused and reported as a CSP violation even though zod
 * catches the error. Parsing without the JIT gives the same results.
 *
 * Every entry of the static build imports this module first: the engine's worker (`worker.ts`) explicitly, and every
 * page through the build's security plugin (`build-csp.ts`), which makes it the first module of each page's entry.
 */
import { z } from "zod";

z.config({ jitless: true });
