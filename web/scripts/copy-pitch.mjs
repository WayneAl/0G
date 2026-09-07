// The deck is authored in `pitch/index.html` and served from the site at
// `/pitch/`. Copying rather than importing keeps the deck a single standalone
// file that still opens with a double-click, which is the property that made it
// useful on stage. The copy lands in `public/` and is gitignored, so the deck
// has exactly one source of truth.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const from = resolve(here, "../../pitch/index.html");
const to = resolve(here, "../public/pitch/index.html");

mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
console.log(`copy-pitch: ${from} -> ${to}`);
