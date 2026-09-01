import { keccak256, toHex } from "viem";
import { InferenceOutput, type TeeAttestation } from "@acu/seal";
import { SYSTEM_PROMPT, buildUserPrompt, extractJson, promptHash } from "./prompt.js";
import type { AuditRequest, InferenceClient, InferenceResult, TrustMode } from "./types.js";

/** Verified live on 2026-09-01 — see NOTES.md §A3. */
export const ROUTER_BASE_URL = {
  testnet: "https://router-api-testnet.integratenetwork.work/v1",
  mainnet: "https://router-api.0g.ai/v1",
} as const;

/**
 * Default model per network. `0gm-1.0-35b-a3b` is mainnet-only: the testnet Router
 * catalog carries exactly two models and neither is it. Testnet falls back to
 * `qwen2.5-omni`, which is TeeTLS-attested and so still satisfies trust mode
 * `verified` (verified = TeeML + TeeTLS). NOTES.md §A3.
 */
export const DEFAULT_MODEL = {
  testnet: "qwen2.5-omni",
  mainnet: "0gm-1.0-35b-a3b",
} as const;

export type OgNetwork = keyof typeof ROUTER_BASE_URL;

export interface RouterClientOptions {
  apiKey: string;
  network: OgNetwork;
  model?: string;
  /**
   * Overridable only because demo scene ⑤ needs to show what a downgrade costs.
   * Everything else should leave it alone.
   */
  trustMode?: TrustMode;
  baseUrl?: string;
  timeoutMs?: number;
}

/** Shape of the Router's `x_0g_trace` block. Confirmed against the live API. */
interface Trace {
  request_id?: string;
  provider?: string;
  billing?: { input_cost?: string; output_cost?: string; total_cost?: string };
  tee_verified?: boolean;
}

export class RouterInferenceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    detail: string,
  ) {
    super(`0G Router ${status}${code ? ` (${code})` : ""}: ${detail}`);
    this.name = "RouterInferenceError";
  }
}

/**
 * 0G Compute Router client.
 *
 * Uses raw fetch rather than the OpenAI SDK on purpose: the attestation evidence
 * lives in the `ZG-Res-Key` response header and the non-standard `verify_tee`
 * request field, and a high-level SDK surface gives access to neither (spec §7.1).
 */
export class RouterClient implements InferenceClient {
  readonly kind = "router" as const;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly trustMode: TrustMode;
  private readonly timeoutMs: number;

  constructor(opts: RouterClientOptions) {
    if (!opts.apiKey) throw new Error("RouterClient: apiKey is required");
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? ROUTER_BASE_URL[opts.network];
    this.model = opts.model ?? DEFAULT_MODEL[opts.network];
    // Pinned here, not at the call site: an omitted trust mode means "no
    // restriction", which would silently let a provider with no attestation
    // serve the request (spec §7.1).
    this.trustMode = opts.trustMode ?? "verified";
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async audit(req: AuditRequest): Promise<InferenceResult> {
    const user = buildUserPrompt(req);
    const body = {
      model: this.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: user },
      ],
      temperature: 0,
      max_tokens: 1024,
      // Top-level, not a header. The Router strips it before forwarding and
      // answers with x_0g_trace.tee_verified.
      verify_tee: true,
    };

    const signal = AbortSignal.timeout(this.timeoutMs);
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "X-0G-Provider-Trust-Mode": this.trustMode,
      },
      body: JSON.stringify(body),
      signal,
    });

    const text = await res.text();
    if (!res.ok) {
      let code: string | undefined;
      let message = text.slice(0, 300);
      try {
        const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
        code = parsed.error?.code;
        message = parsed.error?.message ?? message;
      } catch {
        /* keep the raw body */
      }
      throw new RouterInferenceError(res.status, code, message);
    }

    const json = JSON.parse(text) as {
      id?: string;
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
      x_0g_trace?: Trace;
    };

    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new RouterInferenceError(res.status, "no_content", "response carried no message content");
    }

    // Strict parse. Extra keys are rejected outright rather than dropped, so an
    // artifact that talks the model into inventing a field fails loudly (§6.1).
    const output = InferenceOutput.parse(JSON.parse(extractJson(content)));

    const trace = json.x_0g_trace;
    // Header first, body `id` as documented fallback.
    const chatId = res.headers.get("ZG-Res-Key") ?? json.id ?? null;
    const provider = (trace?.provider?.toLowerCase() ?? null) as `0x${string}` | null;

    const attestation: TeeAttestation | null =
      chatId !== null && trace?.tee_verified === true
        ? {
            chatId,
            teeVerified: true,
            // Resolved from the provider's on-chain service record when we walk
            // the chain; the Router does not hand these back inline.
            teeSignerAddress: null,
            signature: null,
            signedTextHash: keccak256(toHex(content)),
            signatureEndpoint: null,
          }
        : null;

    return {
      output,
      model: json.model ?? this.model,
      trustMode: this.trustMode,
      providerAddress: provider ?? "0x0000000000000000000000000000000000000000",
      promptHash: promptHash(SYSTEM_PROMPT, user),
      responseHash: keccak256(toHex(content)),
      attestation,
      rawText: content,
      costNeuron: trace?.billing?.total_cost ?? null,
    };
  }
}
