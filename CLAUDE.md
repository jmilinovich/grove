# Grove

Grove is a single-user MCP server over a git-backed Obsidian vault. Six tools, no SaaS layer, no autonomous agent, no multi-tenant routing. The vault is sacred; Grove is the plumbing that makes it reachable from any MCP client.

## Architecture rules

1. **The vault is the source of truth.** State.db, QMD indexes, embeddings — all derived. If they diverge, rebuild the derived state.
2. **All writes are serialized.** Single-threaded write queue. No concurrent git operations. Ever.
3. **Every write creates a git commit** with attribution + optional provenance trailers.
4. **Search index updates synchronously on write.** Agents have no memory between calls — eventual consistency means duplicates.
5. **Six tools.** `query`, `get`, `multi_get`, `write_note`, `list_notes`, `vault_status`. If you're adding a seventh, prove it doesn't overlap an existing tool's parameter shape first.

## Running locally

```bash
GROVE_VAULT=/path/to/vault \
GROVE_API_KEY=$(openssl rand -hex 32) \
VOYAGE_API_KEY=... \
npx tsx src/server.ts
```

Listens on `127.0.0.1:8420/mcp`. Set `GROVE_AUTH=none` to bypass the bearer check for local-only dev.

The discovery worker (extract→link engine) is a separate process:

```bash
GROVE_VAULT=/path/to/vault ANTHROPIC_API_KEY=... npx tsx src/discovery-worker.ts
```

## Code conventions

- **TypeScript, strict mode.** No `any` unless interfacing with untyped externals.
- **Raw `node:http`.** No Express, no Fastify. The server is small enough.
- **Node ≥ 22.** Built-in `fetch`, `crypto`. Don't polyfill.
- **ESM only** (`"type": "module"`).
- **Run with `tsx`** in dev.
- **Dependencies are intentionally minimal.** Don't add packages for what Node can do natively.

## What not to do

- Don't add web frameworks. Raw `node:http` is the choice.
- Don't break the MCP protocol. The server speaks `StreamableHTTPServerTransport`; clients connect with a static bearer.
- Don't sprawl tools. Six tools today. The next-cliff is around twelve, where overlap risk starts hurting tool selection.
- Don't write to the vault outside the write queue. Ever.
- Don't store raw API tokens anywhere. Compare in constant time with `timingSafeEqual`.
- Don't re-introduce multi-tenant routing, encryption, OAuth, trails, waitlists, or per-vault key minting. Those were costumes; the teardown was deliberate. (See `RETROSPECTIVE.md`.)

## Testing

Tests use `vitest`. Run them with:

```bash
npm test                    # full suite
npm run typecheck           # tsc --noEmit
```

Write tests for: frontmatter parsing, write-queue serialization, search-result formatting, blame trailer parsing, discovery enqueue dedup.

## What's around

- `RETROSPECTIVE.md` — the deep history of the hosted product and what each layer cost. Read this before reintroducing anything that was deleted.
- `TEARDOWN-RUNBOOK.md` — the day-by-day teardown sequence.
- `SIMPLIFY.md` / `ZOOM-OUT.md` — the decision-audit trail.

## Values

- Momentum over perfection — ship what works, iterate on what doesn't
- Simple until it needs to be complex — no abstractions ahead of need
- Fewer tools, better tools — agents work better with less choice
- The vault is sacred — Grove is plumbing, the vault is the cathedral
