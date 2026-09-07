import "./style.css";
import { wireCopyButtons } from "./copy.js";

/**
 * The docs page is static HTML; the only thing it needs a script for is the copy
 * buttons on its command blocks.
 *
 * It shares that one function with the verifier rather than growing a second
 * copy of it — two implementations of "did the clipboard work" is two things to
 * get wrong — and imports it from `copy.ts` rather than `render.ts` so a page
 * that verifies nothing does not download a verifier.
 */
wireCopyButtons(document);
