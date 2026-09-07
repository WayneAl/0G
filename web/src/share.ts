/**
 * A seal in a link.
 *
 * The seal is the evidence, so the natural thing to hand someone is the seal
 * itself — not an id that points at a server of ours. base64url in the fragment
 * keeps the bytes off every wire between the two of you: a fragment is never
 * sent to the host, so the page that verifies it never learns what it verified.
 */
const PREFIX = "seal=";

export function encodeShare(seal: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(seal));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `#${PREFIX}${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

/**
 * `null` means "this fragment carries no seal I can read" — an absent one, a
 * corrupted one and a truncated one are the same fact to the caller, and each
 * one leaves the page on its idle state rather than throwing at load.
 */
export function decodeShare(fragment: string): unknown | null {
  const hash = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  if (!hash.startsWith(PREFIX)) return null;

  const payload = hash.slice(PREFIX.length).replace(/-/g, "+").replace(/_/g, "/");
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
