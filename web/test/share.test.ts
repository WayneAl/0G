import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeShare, encodeShare } from "../src/share.js";

const SEAL_A: unknown = JSON.parse(
  readFileSync(new URL("../public/examples/example-sealA.json", import.meta.url), "utf8"),
);

describe("share links", () => {
  it("round-trips a real seal through the fragment", () => {
    const fragment = encodeShare(SEAL_A);

    expect(fragment.startsWith("#seal=")).toBe(true);
    // base64url, so the fragment survives a URL bar and a chat client untouched.
    expect(fragment.slice("#seal=".length)).not.toMatch(/[+/=]/);
    expect(decodeShare(fragment)).toEqual(SEAL_A);
  });

  it("returns null rather than throwing on a fragment that is not base64", () => {
    expect(decodeShare("#seal=!!!")).toBeNull();
  });

  it("returns null on a fragment that carries no seal", () => {
    expect(decodeShare("")).toBeNull();
    expect(decodeShare("#about")).toBeNull();
  });

  it("returns null when the payload decodes but is not JSON", () => {
    expect(decodeShare(`#seal=${btoa("not json").replace(/=+$/, "")}`)).toBeNull();
  });
});
