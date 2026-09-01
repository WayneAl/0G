# NOTES.md — 與規格 v2 的差異紀錄

依規格 §0.3:「套件 API 與本文件描述不符時,以實際套件為準,並在 NOTES.md 記錄差異。」

查證日期:2026-09-01。查證方式:npm registry + 解壓 `.d.ts` 讀真實型別;0G 官方文件 +
直接打 live endpoint。**未經查證的項目不寫進本檔。**

---

## A. 三個 `[UNVERIFIED]` 的結論

### A1. x402 v2 套件 — 規格正確,但客戶端套件名寫錯

| 項目 | 規格 v2 說法 | 實際 | 結論 |
|---|---|---|---|
| `@x402/express` / `@x402/evm` / `@x402/core` | 存在 | **2.24.0**(2026-08-27) | ✅ 正確 |
| 舊 `x402-express` / `x402-fetch` | V1,已棄用 | 停在 1.2.0(2026-04-16) | ✅ 正確 |
| Agent A 客戶端 | 「用 `x402-fetch` 或 `x402-axios`」 | 那兩個是 **V1 線** | ❌ **規格自相矛盾** |

**修正:** Agent A 改用 **`@x402/fetch` 2.24.0**(v2 線,與 server 端同版本)。
規格 §7.2 最後一行點名的 `x402-fetch` / `x402-axios` 是 1.x 舊線,不採用。
依 wayne-workflow:不在已棄用的 API 表面上寫新程式。

真實 API(由 `.d.ts` 確認,非文件推測):

```ts
// server —— @x402/evm/exact/server 的 ExactEvmScheme 是「無參數」建構子
//            (implements SchemeNetworkServer);規格範例正確。
//            注意 @x402/evm 根目錄同名的 ExactEvmScheme 是 client 版,要吃 signer。
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

const server = new x402ResourceServer(
  new HTTPFacilitatorClient({ url: FACILITATOR_URL }),   // ctor 吃 FacilitatorConfig
).register("eip155:84532", new ExactEvmScheme());
app.use(paymentMiddleware(routes, server));               // (routes, server) 順序正確

// client
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme as ExactEvmClientScheme } from "@x402/evm/exact/client";
const client = new x402Client().register("eip155:84532", new ExactEvmClientScheme(signer));
const fetchWithPay = wrapFetchWithPayment(fetch, client);
```

`RouteConfig.accepts` 的 `PaymentOption` 實際欄位:
`{ scheme, payTo, price, network, maxTimeoutSeconds?, extra? }` —— 與規格 §7.2 一致。

### A2. 0G Router 的證明表面 —— **可用,規格的單點失敗解除**

規格 §7.1 擔心:「如果 Router 沒有可用的證明表面而我們又只做了 Router,現場就沒有東西
可以當眾驗。」**這個擔心不成立。** Router 路徑今天就有完整的第三方驗證迴路:

1. request body 加 **`verify_tee: true`**(是 **body 的頂層欄位,不是 header**;
   Router 會在轉發給 provider 前 strip 掉)
2. response body 的 `x_0g_trace` 帶回:
   ```jsonc
   { "request_id": "...", "provider": "0x...",
     "billing": { "input_cost": "...", "output_cost": "...", "total_cost": "..." },
     "tee_verified": true }   // true=簽章驗過 / false=有簽章但驗不過 / 缺=沒要求驗
   ```
3. response header **`ZG-Res-Key`** 帶 `chatID`(header 缺席時 fallback 用 body 的 `id`)
4. **任何第三方**可獨立驗證,不需信任 Router:
   `GET {providerUrl}/v1/proxy/signature/{chatID}?model={model}` → `{ text, signature }`,
   以 **EIP-191 `personal_sign`** 對鏈上 service record 的 `teeSignerAddress` 驗簽,
   再確認 `text` 與 Router 回傳內容相符。

「Router 的 Proof ID coming soon」屬實,但 **Proof ID 不是唯一的證明表面** ——
上面四步已經構成可當眾演的驗證迴路。規格把「Proof ID 沒有」誤等於「沒有證明可驗」。

**影響:** Router 是主路徑,Direct 降為備援。可切換介面仍照做(成本低),
但它不再是專案存亡的關鍵。

### A3. `0GM-1.0-35B-A3B` —— **測試網沒有這個模型**

直接打 `/v1/models` 的實際結果(不是文件):

| Router | 模型數 | 內容 |
|---|---|---|
| testnet `router-api-testnet.integratenetwork.work/v1` | **2** | `qwen-image-edit`(圖片)、`qwen2.5-omni`(chatbot) |
| mainnet `router-api.0g.ai/v1` | **32** | 含 `0gm-1.0-35b-a3b`、`0gm-1.0-35b-a3b-sia` |

- 模型 id 實際是**小寫** `0gm-1.0-35b-a3b`,規格寫的 `0GM-1.0-35B-A3B` 是 display name。
- 測試網唯一可用的 chat 模型是 `qwen2.5-omni`:`verifiability: "TeeTLS"`, `tee_attested: true`,
  `tee_type: "TDX"`, `tee_verifier: "dstack"`, context 32768, max_completion 2048。
- `X-0G-Provider-Trust-Mode: verified` = **TeeML + TeeTLS 兩層**,所以 `qwen2.5-omni`
  在測試網**通得過 `verified`**,規格 §6.2 第 6 項的驗證邏輯在測試網成立。
- `0gm-1.0-35b-a3b`:`verifiability: "TeeML"`, TDX/dstack, context 262144,
  max_completion 32768,支援 `response_format` 與 `reasoning_effort`。

**結論:規格的加分項「使用 `0GM-1.0-35B-A3B`」只能在主網達成。**

mainnet `0gm-1.0-35b-a3b` 實際價格:prompt `$0.00000008`/token、completion `$0.00000048`/token。
一次審核約 5k prompt + 1k completion ≈ **$0.0009**。Phase 2 要求的 30 次跑測 ≈ $0.03。

## B. Trust-Mode 三階(官方文件確認)

| 值 | 涵蓋 |
|---|---|
| `standard` | 所有 provider,含第三方通道 |
| `verified` | **TeeML + TeeTLS** provider |
| `private` | 僅 TeeML(最高隱私) |

其他已確認 header:`X-0G-Provider-Address`、`X-0G-Provider-Sort`(`latency`|`price`)、
`X-0G-Provider-Allow-Fallbacks`(pin provider 時預設轉 `false`)、
`X-0G-Provider-Max-Price-Usd-Prompt` / `-Completion` / `-Image`。

**影響 demo 第 ⑤ 幕:** 測試網沒有 `standard` 層的非 attested provider,
所以「Agent B 改用便宜的無 attestation 推理」無法用真的 provider 演。
改成 Agent B 送出**缺 `teeAttestation` 的章 B**(即 agent 自己不做驗證那步),
Agent A 照樣拒絕 —— 這個框架其實更誠實:擋的是「章沒帶證明」,不是「provider 不好」。

## C. 0G Compute SDK 套件已改名

`@0glabs/0g-serving-broker` **已棄用**,官方 shim 指向 **`@0gfoundation/0g-compute-ts-sdk`**
(latest 0.9.0)。Direct 路徑用後者。

## D. 鏈上參數(live RPC 實測)

| 項目 | 值 |
|---|---|
| 0G testnet chainId | **16602** (`0x40da`),RPC `https://evmrpc-testnet.0g.ai` ✅ 活著 |
| Base Sepolia chainId | 84532 (`0x14a34`) ✅,CAIP-2 `eip155:84532` 與規格一致 |

## E. 尚未解除的阻擋項

1. **0G API key 未取得** —— 需錢包連線 + 儲值,測試網 `pc.testnet.0g.ai`、
   主網 `pc.0g.ai`,Dashboard → API Keys → Create,拿到 `sk-` 開頭的 key。
   Phase 1 不受影響,Phase 2 起卡住。
2. 本機 Foundry 是 0.2.0(2024-03-28 建置),偏舊,建議 `foundryup`。
