export interface AuditorStatus {
  online: boolean;
  card: unknown | null;
  price: string | null;
}

const OFFLINE: AuditorStatus = { online: false, card: null, price: null };

/**
 * Is there an auditor at this origin right now, and what does it charge?
 *
 * The reference Agent B is one container that scales to zero when idle, and the
 * 0G testnet quota it runs on is 50 audits a day — so "offline" is an ordinary
 * state of this system, not a fault of the page. That is why every failure —
 * DNS, CORS, a 502, a body that is not JSON, four seconds of nothing —
 * collapses to the same answer instead of throwing: the pill has one job, and a
 * visitor who cannot reach the auditor still gets a page that verifies seals.
 *
 * The path is dropped, not appended to: the card lives at `/agent` on the
 * origin, exactly as the MCP's `describe_auditor` reads it.
 */
export async function auditorStatus(
  endpoint: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<AuditorStatus> {
  let url: string;
  try {
    url = new URL("/agent", endpoint).toString();
  } catch {
    return OFFLINE;
  }

  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return OFFLINE;
    const card: unknown = await res.json();
    const price =
      typeof card === "object" && card !== null && typeof (card as Record<string, unknown>)["price"] === "string"
        ? ((card as Record<string, unknown>)["price"] as string)
        : null;
    return { online: true, card, price };
  } catch {
    return OFFLINE;
  }
}
