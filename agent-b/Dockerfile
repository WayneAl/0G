# The reference Agent B, as an image.
#
# Build context is the repo root, not agent-b/ — the server imports three
# workspace packages by source (`@0x402/auditor` exports `./src/index.ts`; only
# the npm tarballs are compiled), so the build needs the workspace, the lockfile
# and pnpm's resolution, not just this directory.
#
#   docker build -f agent-b/Dockerfile -t acu-agent-b .
#
# Nothing secret is baked in. AGENT_B_PRIVATE_KEY and TESTNET_API_KEY arrive at
# runtime; the server reads `../../.env` first, finds none in the image, and
# falls through to the real environment.
#
# Running it locally against the repo's .env needs one override, because
# `--env-file` keeps the quotes that dotenv would strip:
#
#   docker run --rm --env-file .env -e 'AGENT_B_PRICE=$0.01' -p 4021:4021 acu-agent-b
FROM node:22-alpine

RUN corepack enable
WORKDIR /repo

# Manifests before sources, so editing a .ts file does not re-resolve the graph.
# Every workspace member's package.json has to be here even though most are not
# installed: --frozen-lockfile checks the lockfile against the whole workspace,
# and a missing manifest reads as a lockfile that has drifted.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/auditor/package.json     packages/auditor/
COPY packages/cli/package.json         packages/cli/
COPY packages/config/package.json      packages/config/
COPY packages/mcp/package.json         packages/mcp/
COPY packages/og/package.json          packages/og/
COPY packages/seal/package.json        packages/seal/
COPY packages/storage/package.json     packages/storage/
COPY packages/underwriter/package.json packages/underwriter/
COPY agent-a/package.json              agent-a/
COPY agent-b/package.json              agent-b/
COPY demo/package.json                 demo/
COPY web/package.json                  web/

# `...` means "agent-b and what it depends on" — seal, og, auditor and no more.
# Dev dependencies stay: `pnpm start` is `tsx src/server.ts`, so tsx is what
# runs the service, not a build tool that could be dropped afterwards.
RUN pnpm install --frozen-lockfile --filter @0x402/agent-b...

COPY tsconfig.base.json ./
COPY packages/seal    packages/seal
COPY packages/og      packages/og
COPY packages/auditor packages/auditor
COPY agent-b          agent-b

# After the install, so it cannot be read as a request to skip dev dependencies.
ENV NODE_ENV=production
ENV AGENT_B_PORT=4021
EXPOSE 4021

# This process holds a signing key. It has no reason to be root.
USER node

WORKDIR /repo/agent-b
CMD ["pnpm", "start"]
