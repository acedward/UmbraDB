/**
 * The explorer page of the static build (`index.html`): the MIP-0018 token explorer (`../mip0018/ui/page.js`, the same
 * script `GET /ui` serves) reading the API through the browser engine, plus the engine panel. The order of the imports
 * is the order they run: the engine connection and the explorer's host first (`explorer-host.ts`), then the explorer
 * script, which reads the host when it starts.
 */
import { client, persistence, tabs } from "./explorer-host.ts";
import "../mip0018/ui/page.js";
import { mountEnginePanel } from "./engine-panel.ts";

const header = document.querySelector("body > header");
if (header === null) throw new Error("the explorer page has no header");
mountEnginePanel({ client, tabs, after: header, persistence });
