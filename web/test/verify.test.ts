import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Directory, resolverFromDirectory } from "@0x402/seal";
import { reportSeal } from "../src/verify.js";

/**
 * The page's report is a *view* of `@0x402/seal`, not a second implementation of
 * it. So these tests hold it to the two things a view can get wrong: the rows it
 * shows, and which of them it claims were actually reached.
 *
 * The resolver is the directory the site itself ships, so a directory that
 * stopped matching the bundled examples fails here rather than in a browser.
 */
const read = (p: string): unknown => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));

const SEAL_A = read("../public/examples/example-sealA.json") as Record<string, unknown>;
const EXAMPLES = read("../public/examples/examples.json") as Record<string, Record<string, unknown>>;
const DIRECTORY = Directory.parse(read("../public/directory.json"));

const resolver = resolverFromDirectory(DIRECTORY);
// After every bundled seal was issued (2026-09-07) and long before any expires.
const now = 1788760200;

const rowNames = (rows: { name: string }[]): string[] => rows.map((r) => r.name);
const row = (rows: { name: string; ok: boolean; detail: string }[], name: string) =>
  rows.find((r) => r.name === name)!;

describe("reportSeal", () => {
  it("reports the recorded seal A as valid and walks into its delegation", async () => {
    const report = await reportSeal(SEAL_A, { resolver, now });

    expect(report.kind).toBe("underwriting");
    expect(report.valid).toBe(true);
    expect(report.failure).toBeNull();
    expect(report.signer).toBe("0x6ddF162A95123AaD1355E5D2FB66C2B1015Adc41");
    expect(report.checks.every((c) => c.ok)).toBe(true);
    expect(report.children).toHaveLength(1);

    const inner = report.children[0]!;
    expect(inner.kind).toBe("audit");
    expect(inner.valid).toBe(true);
    expect(rowNames(inner.checks)).toEqual([
      "SCHEMA",
      "AGENT_ID_LIVE",
      "SIGNATURE",
      "SUBJECT",
      "REQUEST",
      "EXPIRY",
      "ATTESTATION",
      "TRUST_TIER",
    ]);
    expect(inner.checks.every((c) => c.ok)).toBe(true);
    expect(inner.signer).toBe("0xC1Dba83fd85838542b09ec44e6372485f6EE2D9E");
    expect(inner.attestation?.teeVerified).toBe(true);
  });

  it("stops at SIGNATURE on the seal whose verdict was rewritten in flight", async () => {
    const report = await reportSeal(EXAMPLES["tampered"]!, { resolver, now });

    expect(report.valid).toBe(false);
    expect(report.failure).toBe("SIGNER_MISMATCH");
    expect(row(report.checks, "SCHEMA").ok).toBe(true);
    expect(row(report.checks, "AGENT_ID_LIVE").ok).toBe(true);
    expect(row(report.checks, "SIGNATURE").ok).toBe(false);
    for (const name of ["SUBJECT", "REQUEST", "EXPIRY", "ATTESTATION", "TRUST_TIER"]) {
      expect(row(report.checks, name)).toMatchObject({ ok: false, detail: "not reached" });
    }
  });

  it("stops at ATTESTATION on the seal that claims an attested tier and carries none", async () => {
    const report = await reportSeal(EXAMPLES["noattest"]!, { resolver, now });

    expect(report.valid).toBe(false);
    expect(report.failure).toBe("ATTESTATION_MISSING");
    expect(report.attestation).toBeNull();
    for (const name of ["SCHEMA", "AGENT_ID_LIVE", "SIGNATURE", "SUBJECT", "REQUEST", "EXPIRY"]) {
      expect(row(report.checks, name).ok).toBe(true);
    }
    expect(row(report.checks, "ATTESTATION").ok).toBe(false);
    expect(row(report.checks, "TRUST_TIER")).toMatchObject({ ok: false, detail: "not reached" });
  });

  it("reports an expired seal honestly while the hash rows stay green", async () => {
    const expired = await reportSeal(SEAL_A, { resolver, now: 1796536092 });

    expect(expired.valid).toBe(false);
    expect(expired.failure).toBe("SEAL_EXPIRED");
    expect(row(expired.checks, "SIGNATURE").ok).toBe(true);
    expect(row(expired.checks, "EXPIRY").ok).toBe(false);
  });

  it("fails the subject row when the seal is about a different token", async () => {
    const report = await reportSeal(SEAL_A, {
      resolver,
      now,
      expectedSubject: "0x0000000000000000000000000000000000000001",
    });

    expect(report.failure).toBe("SUBJECT_MISMATCH");
    expect(row(report.checks, "SUBJECT").ok).toBe(false);
  });

  it("names SCHEMA on something that is not a seal at all", async () => {
    const report = await reportSeal({ hello: "world" }, { resolver, now });

    expect(report.valid).toBe(false);
    expect(report.failure).toBe("SCHEMA_INVALID");
    expect(row(report.checks, "SCHEMA").ok).toBe(false);
    expect(report.children).toHaveLength(0);
  });
});
