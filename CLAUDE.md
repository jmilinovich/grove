# Grove

Grove is a hosted knowledge API that makes Obsidian vaults searchable and writable from any Claude surface.

## Architecture rules

1. **The vault is the source of truth.** QMD indexes are derived. If they diverge, the index is wrong — rebuild it.
2. **The server is the sole writer to git.** Local machines pull. One direction. No split brain.
3. **All writes are serialized.** Single-threaded write queue. No concurrent git operations. Ever.
4. **Every write creates a git commit** with the API key identity in the message.
5. **Search index updates synchronously on write.** Agents have no memory between calls — eventual consistency means duplicates.
6. **Keep tools distinct and composable.** Current count: 6. The original rule said "≤6 because selection degrades past ~10" — 2026 benchmarks showed that's not quite right. The real cliff is around 50 tools; Anthropic's Tool Search Tool (shipped Q1 2026) mostly eliminates count sensitivity by loading tool definitions on demand. The value of the rule was never the number 6 specifically; it was tool *overlap risk*. Before adding a new tool, check: does an existing tool with a new parameter serve? A 7th or 8th tool is fine if it earns its slot. A 20th isn't. If count climbs past 12, stop and reconsider the design.

Read `PLAN.md` for the full spec. This file governs how you work — PLAN.md governs what you build.

## Running locally

```bash
npm run proxy          # Auth proxy on :8420, proxies to QMD MCP (:8181) and BM25 (:8177)
grove keys             # List API keys (remote, via ~/.grove/cli.json)
grove keys create foo  # Create a new key (token shown once)
grove keys revoke id   # Revoke a key
```

Requires QMD running separately. The proxy does not start QMD — it expects it on ports 8181 (MCP) and 8177 (BM25 search).

## Running on AWS

Grove runs on AWS g4dn.xlarge (T4 GPU) at `api.grove.md`. PM2 manages five processes: `grove-server` (8190), `grove-proxy` (8420), `grove-discovery` (worker, no port), `qmd-server` (8177), `embed-server` (8090). Nginx terminates TLS.

```bash
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231
sudo pm2 list               # see process status
sudo pm2 restart grove-server # restart
sudo pm2 logs grove-server   # tail logs
```

Embedding uses sentence-transformers (not TEI — TEI FlashQwen3 CUDA kernel returns nulls).
Vault syncs every 5 min via cron. Keys live at `~/.grove/keys.json`.

## Code conventions

- **TypeScript, strict mode.** No `any` unless interfacing with untyped externals.
- **Raw `node:http`.** No Express, no Fastify, no framework. The server is small enough.
- **Node >= 22.** Use built-in fetch, crypto, etc. Don't polyfill.
- **ESM only** (`"type": "module"` in package.json).
- **Run with `tsx`** in dev. Compile for production.
- **Dependencies are intentionally minimal.** Don't add packages for things Node can do natively.

## What not to do

- Don't add web frameworks. Raw `node:http` is the choice and it's final.
- Don't break the MCP protocol. Claude.ai connects as a custom connector — if the proxy changes response shape, it breaks every connected surface.
- Don't sprawl MCP tools. 6 is the current count; 10–12 is fine on modern models; past that, tool-overlap hurts selection even if raw model performance holds. See architecture rule #6.
- Don't write to the vault outside the write queue. Ever.
- Don't store raw API tokens anywhere. Hash with SHA-256 first.
- Don't over-engineer. This is a proxy today, growing into a server. Build what's needed now.

## Testing

Tests use `vitest`. Test fixtures live in `test/fixtures/vault/` — a small vault with sample notes, proper frontmatter, and an initialized git repo.

```bash
npm test                    # run all tests
npm run test -- --watch     # watch mode
```

Write tests for: frontmatter parsing, auth/token validation, write queue serialization, search result formatting. Integration tests should cover full request cycles through the proxy.

## Relationship to QMD

Grove wraps QMD. It does not replace it. QMD handles indexing, BM25 search, and MCP tool execution. Grove adds auth, write operations, git integration, and the HTTP surface that Claude.ai connects to.

If search quality regresses, the problem is almost certainly in QMD or its index — not in Grove's proxy layer.

## Relationship to the vault

Grove serves the vault at `~/life/`. It does not own it. The vault is an Obsidian-based, git-tracked knowledge system that predates Grove and will outlive it. Grove is infrastructure that makes the vault accessible remotely — it should never restructure, reorganize, or make policy decisions about vault content.

Vault conventions (frontmatter, linking, folder structure) are defined in `~/life/CLAUDE.md`. Read that before building anything that touches note structure.

## Deploy process

Deploys run through GitHub Actions (`.github/workflows/ci.yml`, `deploy` job) via `workflow_dispatch` — health-gated with auto-rollback. Trigger from the Actions tab after `main` is green. Set `confirm_schema_change=true` when the deploy touches `src/db.ts` or `src/db-migration*.ts`.

Manual fallback (only when Actions is down):

```bash
ssh -i ~/.ssh/grove-aws.pem ubuntu@52.37.76.231
sudo bash -c 'cd /root/grove && git pull && npm install'
sudo pm2 restart grove-server grove-proxy grove-discovery
```

## Values

- Momentum over perfection — ship what works, iterate on what doesn't
- Simple until it needs to be complex — no abstractions ahead of need
- Fewer tools, better tools — agents work better with less choice
- The vault is sacred — Grove is plumbing, the vault is the cathedral
