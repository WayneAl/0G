/**
 * Copy buttons, wired once. Both pages use them; neither should own the logic.
 *
 * Its own module rather than a corner of `render.ts` for one reason: the docs
 * page needs nothing else from the renderer, and `render.ts` reaches `@0x402/seal`
 * through `verify.ts`. Sharing the file would have shipped keccak, secp256k1 and
 * zod to a page whose only interactive element is a clipboard.
 */
export function wireCopyButtons(root: ParentNode = document): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>("button.copy")) {
    button.addEventListener("click", () => {
      const code = button.parentElement?.querySelector("code")?.textContent ?? "";
      const restore = button.textContent ?? "Copy";
      void navigator.clipboard.writeText(code).then(
        () => {
          button.textContent = "Copied";
          setTimeout(() => (button.textContent = restore), 1400);
        },
        () => {
          // Clipboard is permissioned. Say so instead of pretending it worked.
          button.textContent = "Select it";
          setTimeout(() => (button.textContent = restore), 1800);
        },
      );
    });
  }
}
