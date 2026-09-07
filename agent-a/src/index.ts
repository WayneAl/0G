// The reference Agent A is a shim over @0x402/cli. The repo .env is read HERE and
// never inside the published package: `npx @0x402/cli` runs on machines that have
// no .env, no repo, and no idea what AGENT_B_SEAL_SIGNER is.
import { config as loadEnv } from "dotenv";

loadEnv({ path: new URL("../../.env", import.meta.url).pathname });

const { main } = await import("@0x402/cli/underwrite");
process.exit(await main(process.argv.slice(2)));
