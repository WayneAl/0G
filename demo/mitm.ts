/**
 * A man in the middle between Agent A and Agent B.
 *
 * Forwards everything faithfully, including the x402 headers in both
 * directions, except that it rewrites seal B's verdict from DENY to ALLOW and
 * raises the LTV cap. The signature is left exactly as Agent B produced it.
 *
 * This is demo scene ⑥, and it is the sharpest claim the project makes: the
 * attacker sits on the wire, both agents behave correctly, nobody is watching,
 * and the forgery still fails — because Agent A verifies the seal itself
 * instead of trusting what arrived.
 *
 *   pnpm --filter @0x402/demo mitm            # listens on 4099, forwards to 4021
 */
import { createServer } from "node:http";

const LISTEN = Number(process.env["MITM_PORT"] ?? 4099);
const UPSTREAM = process.env["MITM_UPSTREAM"] ?? "http://localhost:4021";

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    void (async () => {
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string" && k !== "host" && k !== "content-length") headers.set(k, v);
      }

      const upstream = await fetch(`${UPSTREAM}${req.url ?? "/"}`, {
        method: req.method ?? "GET",
        headers,
        ...(body.length ? { body } : {}),
      });

      const text = await upstream.text();
      let out = text;

      if (upstream.status === 200) {
        try {
          const parsed = JSON.parse(text) as {
            audit?: { action?: string; maxLtvBps?: number };
            sealB?: { verdict?: { action?: string; maxLtvBps?: number } };
          };
          if (parsed.sealB?.verdict) {
            const before = `${parsed.sealB.verdict.action}/${parsed.sealB.verdict.maxLtvBps}`;
            // Rewrite the verdict. Leave `signature` alone — that is the point.
            parsed.sealB.verdict.action = "ALLOW";
            parsed.sealB.verdict.maxLtvBps = 9000;
            if (parsed.audit) {
              parsed.audit.action = "ALLOW";
              parsed.audit.maxLtvBps = 9000;
            }
            out = JSON.stringify(parsed);
            console.log(`[mitm] rewrote seal B verdict ${before} -> ALLOW/9000, signature untouched`);
          }
        } catch {
          // Not JSON we understand; pass it through unchanged.
        }
      }

      for (const [k, v] of upstream.headers.entries()) {
        if (k === "content-length" || k === "content-encoding" || k === "transfer-encoding") continue;
        res.setHeader(k, v);
      }
      res.writeHead(upstream.status);
      res.end(out);
    })();
  });
});

server.listen(LISTEN, () => {
  console.log(`[mitm] listening on :${LISTEN}, forwarding to ${UPSTREAM}`);
  console.log(`[mitm] will rewrite seal B verdicts to ALLOW/9000 without touching the signature`);
});
