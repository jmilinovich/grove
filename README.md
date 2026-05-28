# Grove

**Open-source MCP server that makes your Obsidian vault searchable and writable from any AI client.**

Six tools, one git-backed vault, single-user. Claude, ChatGPT, Cursor, or any MCP-compatible client connects and gets structured access — search, read, write-back, graph diagnostics. Your vault stays yours: markdown files in a git repo, versioned forever.

```
┌─────────────────────────────────────────────────────────┐
│              MCP client (Claude / Cursor / …)            │
└──────────────────────┬──────────────────────────────────┘
                       │ MCP — Streamable HTTP + Bearer
                       ▼
┌─────────────────────────────────────────────────────────┐
│                       grove-server                       │
│   6 tools · write queue · provenance · discovery        │
└──────────────────────┬──────────────────────────────────┘
                       │
            ┌──────────┼──────────┐
            ▼          ▼          ▼
        Hybrid      Vault       Discovery
        Search      (git)        worker
      BM25+Vec               (extract → link)
```

> **About this repo.** Grove was a hosted product 2026-04 → 2026-05. The repo
> you're looking at is the open-source cathedral that came out of it: a
> personal MCP layer over an Obsidian vault, single-user, self-host. The
> multi-tenant SaaS layer, autonomous-agent layer, encryption, trails,
> waitlist, and admin portal have all been stripped. See `RETROSPECTIVE.md`
> for the full history.

---

## The six tools

| Tool | What it does |
|---|---|
| `query` | Hybrid BM25 + vector + title search with RRF fusion. Returns ranked snippets with URLs. |
| `get` | Read a note by path or title. Surfaces per-segment provenance (durable vs perishable voice). |
| `multi_get` | Batch read via glob or comma-separated paths. |
| `write_note` | Create / update / soft-delete / hard-delete / move a note. Single op or batch (atomic optional). |
| `list_notes` | List notes matching a pattern. Optional alias resolution. |
| `vault_status` | Health, history, diagnostics, graph, lifecycle digest, discovery state, perf counters. |

Every write is a git commit. Every commit can carry provenance trailers that the read path surfaces via blame so future readers know what's the user's standing thinking vs an AI's moment-in-time synthesis.

---

## Quick start

You need:

- Node ≥ 22
- A git-backed Obsidian-style markdown vault on disk
- A [QMD](https://github.com/tobilu/qmd) index for the vault (Grove reads BM25 + vector hits from it)
- A [Voyage AI](https://voyageai.com/) API key for per-write embeddings (`voyage-4-large`)

```bash
git clone https://github.com/jmilinovich/grove.git
cd grove
npm install
```

Set the env vars:

```bash
export GROVE_VAULT=/path/to/your/vault       # absolute path to the git repo
export GROVE_API_KEY=$(openssl rand -hex 32) # your bearer token — keep secret
export VOYAGE_API_KEY=...                    # Voyage AI key for embeddings
```

Then start the server:

```bash
npx tsx src/server.ts
```

It listens on `http://127.0.0.1:8420/mcp`. Point any MCP client at that URL with `Authorization: Bearer <GROVE_API_KEY>`.

### Local-only without a token

For purely local development you can disable auth:

```bash
GROVE_AUTH=none GROVE_VAULT=/path/to/vault npx tsx src/server.ts
```

Only do this when the listener is bound to localhost.

---

## Discovery worker (optional)

The discovery worker runs in the background and auto-wikilinks new notes by extracting entities from each write. It's a separate process:

```bash
GROVE_VAULT=/path/to/vault \
ANTHROPIC_API_KEY=... \
npx tsx src/discovery-worker.ts
```

If you don't run it, writes still work — they just don't get auto-linked. The discovery queue + cache live in `~/.grove/state.db` and will resume when the worker comes back.

---

## Env reference

| Var | Required? | Default | Purpose |
|---|---|---|---|
| `GROVE_VAULT` | yes | `$HOME/life` | Absolute path to the vault git repo |
| `GROVE_API_KEY` | yes (unless `GROVE_AUTH=none`) | empty | Bearer token clients must send |
| `GROVE_AUTH` | no | `bearer` | Set to `none` to disable auth (localhost only) |
| `GROVE_PORT` | no | `8420` | HTTP listen port |
| `GROVE_STATE_DB` | no | `~/.grove/state.db` | SQLite state file (discovery queue, provenance, blame cache) |
| `GROVE_PUBLIC_BASE_URL` | no | `grove://vault` | Prefix used when minting URLs returned by tool calls |
| `VOYAGE_API_KEY` | for embed-on-write | — | Voyage AI key |
| `ANTHROPIC_API_KEY` | for the discovery worker | — | Anthropic key for the extract→link engine |
| `GROVE_INTERNAL_TOKEN` | optional | — | Bearer for the `/internal/post-sync-warmup` cron hook |

---

## What's in the box

```
src/
├── server.ts          # MCP HTTP server, the 6 tools, bearer-auth gate
├── rest.ts            # write / delete / move / batch handlers (git write-queue)
├── write-queue.ts     # single-writer mutex per vault
├── hybrid-search.ts   # BM25 + vector + RRF fusion over the QMD index
├── embed-single.ts    # per-write embed → Voyage AI → QMD index
├── notes-validate.ts  # frontmatter validation, hash, serialize/parse
├── provenance.ts      # durable/perishable voice, commit trailers
├── blame.ts           # per-segment authorship from git blame + trailers
├── discovery*.ts      # extract → link engine (auto-wikilinking on write)
├── graph-health.ts    # vault health metrics + flags
├── vault-graph.ts     # wikilink graph + clusters
├── vault-stats.ts     # cached stats for vault_status
├── vault-config.ts    # detection + loading of the vault structure
└── db.ts              # single SQLite state-db for discovery + provenance + blame
```

---

## Code conventions

- **TypeScript strict mode.** No `any` except at untyped externals.
- **Raw `node:http`.** No Express / Fastify.
- **Node ≥ 22**, ESM only, built-in `fetch` + `crypto`.
- **Dependencies are intentionally minimal** (`@modelcontextprotocol/sdk`, `better-sqlite3`, `zod`, `yaml`).
- **The vault is sacred** — Grove is plumbing. Never restructure or make policy decisions about vault content.

## Architecture rules

1. **The vault is the source of truth.** All other state (state.db, QMD index) is derived. If they diverge, the derived state is wrong — rebuild it.
2. **All writes are serialized** via the write queue. No concurrent git operations.
3. **Every write creates a git commit** with attribution.
4. **Search index updates synchronously on write** so the agent's next call sees the change.
5. **Keep the tool count small.** Six tools today. If you're adding a tenth, stop and reconsider.

---

## License

MIT. See `LICENSE`.
