import { z } from "zod";
import { Address } from "./schema.js";
import { StaticAgentIdResolver, type AgentIdResolver } from "./verify.js";

/**
 * Who the network's agents are, until Agentic ID minting is live.
 *
 * `AgentIdResolver` is the seam the verifier already goes through; this is the
 * cheapest honest thing behind it — a JSON file someone publishes, fetched once.
 * It is deliberately *not* an authority: a directory can only ever say which key
 * an id claims, and every seal still has to recover to that key locally. Swapping
 * this for an on-chain read changes nothing else in the codebase.
 */
export const DirectoryEntry = z.object({
  agentId: z.string().min(1),
  signer: Address,
  role: z.enum(["auditor", "underwriter"]),
  endpoint: z.string().url().optional(),
  price: z.string().optional(),
});
export type DirectoryEntry = z.infer<typeof DirectoryEntry>;

export const Directory = z.object({ agents: z.array(DirectoryEntry) });
export type Directory = z.infer<typeof Directory>;

/** The in-memory resolver a directory describes. */
export function resolverFromDirectory(d: Directory): StaticAgentIdResolver {
  const table: Record<string, `0x${string}`> = {};
  for (const agent of d.agents) table[agent.agentId] = agent.signer;
  return new StaticAgentIdResolver(table);
}

/**
 * Fetches a `Directory` once, lazily, and answers `resolve` from it.
 *
 * The fetch is memoized as a *promise*, so two concurrent verifications share one
 * request; a rejection is not memoized, because a directory that was unreachable
 * for a second must not stay unreachable for the life of the process. Both a
 * non-2xx and a body that does not parse throw — an empty resolver would turn
 * every seal into `AGENT_ID_NOT_LIVE` and hide the real fault.
 */
export class HttpAgentIdResolver implements AgentIdResolver {
  private pending: Promise<Directory> | null = null;

  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  directory(): Promise<Directory> {
    if (this.pending === null) {
      this.pending = this.load().catch((err: unknown) => {
        this.pending = null;
        throw err;
      });
    }
    return this.pending;
  }

  private async load(): Promise<Directory> {
    // Read off `this` first. A browser's `fetch` refuses to run with any
    // receiver but the window, so `this.fetchImpl(url)` — a method call on the
    // resolver — throws `Illegal invocation` in every browser while passing in
    // Node. `@0x402/storage`'s gateway fetch already takes it as a local for the
    // same reason.
    const doFetch = this.fetchImpl;
    const res = await doFetch(this.url);
    if (!res.ok) {
      throw new Error(`DIRECTORY_UNREACHABLE: ${res.status} from ${this.url}`);
    }
    return Directory.parse(await res.json());
  }

  async resolve(agentId: string): Promise<`0x${string}` | null> {
    const dir = await this.directory();
    return dir.agents.find((a) => a.agentId === agentId)?.signer ?? null;
  }
}
