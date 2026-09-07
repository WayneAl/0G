/**
 * Everything the page needs to reach the world, in one place.
 *
 * All of it is public read-only infrastructure: an RPC, a storage gateway, and
 * two JSON files this site serves itself. There is no API of ours here, because
 * there is nothing for one to do — verification runs in the visitor's browser.
 */

/** `CollateralRegistry` on 0G Galileo testnet. */
export const REGISTRY = "0xC1AAfd71480Ebc92C7F9fcC4d24272bd7B46a65E" as const;

/**
 * The block `CollateralRegistry` was deployed in (2026-09-01T15:02:35Z), found by
 * bisecting `eth_getCode` on the public RPC. The feed stops walking here: below
 * it there is no registry, so there is nothing to find.
 */
export const REGISTRY_DEPLOY_BLOCK = 52_557_531n;

export const RPC = "https://evmrpc-testnet.0g.ai";
export const INDEXER = "https://indexer-storage-testnet-turbo.0g.ai";

export const CHAINSCAN = "https://chainscan-galileo.0g.ai";
export const STORAGESCAN = "https://storagescan-galileo.0g.ai";

/** BASE_URL follows `vite build --base`, so the same bundle works at `/` and at `/0G/`. */
export const DIRECTORY_URL = `${import.meta.env.BASE_URL}directory.json`;
export const EXAMPLES_URL = `${import.meta.env.BASE_URL}examples/examples.json`;

/** The token the reference pair underwrites, and the one the install line names. */
export const CLEAN_USD = "0xDB08Ce217Ce842b06baf76a0Bbb2C10f47fF9eB8" as const;

export const INSTALL_CLI = "npx @acu/cli init";
export const INSTALL_UNDERWRITE = `npx @acu/cli underwrite ${CLEAN_USD}`;
export const INSTALL_MCP = "claude mcp add acu -- npx -y @acu/mcp";
