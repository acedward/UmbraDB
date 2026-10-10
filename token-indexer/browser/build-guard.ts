/**
 * A Vite plugin that refuses, at build time, a browser bundle that would contain postgres.js or a Node built-in module
 * imported by this repository's code: the build fails naming the importing module. Dependencies may still import a Node
 * built-in behind a runtime check (PGlite does, for its Node file system); Vite replaces those with an empty module.
 * After bundling it also refuses any chunk holding a module from the postgres.js package.
 */
import { builtinModules } from "node:module";
import path from "node:path";
import type { Plugin } from "vite";

const isPostgresJs = (spec: string): boolean => spec === "postgres" || spec.startsWith("postgres/");
const isNodeBuiltin = (spec: string): boolean => spec.startsWith("node:") || builtinModules.includes(spec);
const inNodeModules = (file: string): boolean => file.split(/[\\/]/).includes("node_modules");

export function nodeFreeBundle(repoRoot: string): Plugin {
  const shown = (file: string): string => path.relative(repoRoot, file.replace(/\?.*$/, "")).split(path.sep).join("/");
  return {
    name: "umbradb-node-free-bundle",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer === undefined) return null;
      if (isPostgresJs(source)) throw new Error(`${shown(importer)} imports ${source} (postgres.js): the browser build must not contain it`);
      if (!inNodeModules(importer) && isNodeBuiltin(source))
        throw new Error(`${shown(importer)} imports the Node module ${source}: the browser build must not contain Node built-ins`);
      return null;
    },
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) {
        if (item.type !== "chunk") continue;
        const bad = item.moduleIds.filter((id) => /[\\/]node_modules[\\/]postgres[\\/]/.test(id));
        if (bad.length > 0) throw new Error(`chunk ${item.fileName} contains postgres.js (${bad.map(shown).join(", ")})`);
      }
    },
  };
}
