# Grove

### Open-source MCP server that makes your Obsidian vault accessible from any AI client.

One URL. Claude, ChatGPT, Cursor, or any MCP-compatible client connects and gets structured access — search, read, write-back, graph analysis. Your vault stays yours: markdown files in a git repo, versioned forever.

**Connect any client:**

```
https://api.grove.md/mcp
```

```
┌─────────────────────────────────────────────────────────┐
│                    Claude (any surface)                  │
│              phone · web · desktop · Code                │
└──────────────────────┬──────────────────────────────────┘
                       │ MCP (Streamable HTTP + OAuth)
                       ▼
┌─────────────────────────────────────────────────────────┐
│                    Grove Server                          │
│   Auth · Rate Limiting · Write Queue · Trails · Graph    │
└──────────────────────┬──────────────────────────────────┘
                       │
            ┌──────────┼──────────┐
            ▼          ▼          ▼
        Hybrid      Vault      Write
        Search      (git)      Queue
      BM25+Vec               (mutex)
            │          │          │
            ▼          ▼          ▼
┌─────────────────────────────────────────────────────────┐
│           Your Obsidian Vault (git-tracked)              │
│           markdown files · frontmatter · wikilinks       │
└─────────────────────────────────────────────────────────┘
```

Karpathy's [LLM Knowledge Bases](https://x.com/karpathy/status/2039805659525644595) thread described the problem: "I think there is room here for an incredible new product instead of a hacky collection of scripts." He's using brute-force context windows and LLM-maintained index files to manage a personal knowledge base in Obsidian. That works at 100 articles. It doesn't work at 1,000 notes accumulated over years — journal entries, concept notes, people, recipes, projects — where the connections between ideas matter as much as the ideas themselves.

Grove is the infrastructure layer. Not another note-taking app. Not a RAG pipeline. A self-hosted server that exposes six structured MCP tools — carefully designed to compose into higher-level workflows without overwhelming agent tool selection.

## How I got here

I keep my life in an Obsidian vault. ~1,000 notes, PARA-organized, git-tracked. Journal entries going back years. Concept notes on ideas I've been developing across multiple jobs. People, recipes, a financial plan, business notes. Connected with wikilinks into a knowledge graph.

I built a set of Claude skills to tend this vault like a garden — searching for notes, planting new concepts, harvesting entities from journal entries, detecting withering ideas that need attention. It worked. But only from my laptop. Only in Claude Code. Only when Obsidian was open and the local search server was running.

Then I opened Claude on my phone during a conversation and realized: it had no idea who I was. Every concept, every person, every connection — gone. I was starting from zero in every conversation that wasn't on my one machine.

So I put the search engine on a VPS. Added auth. Added write-back so Claude could plant notes from anywhere, not just read them. Added frontmatter validation so agents couldn't corrupt the vault. Added a graph analyzer so Claude could understand the shape of my knowledge, not just search it. Every write creates a git commit. Every commit is auditable. The vault is the source of truth — the index is derived.

Three weeks in, I haven't manually searched my own notes once. Claude finds what I need in ~30ms from any surface. When it learns something new in a conversation, it plants it. The knowledge compounds.

## The six tools

Grove exposes exactly six MCP tools. Not twelve, not twenty. Six. Agent tool selection degrades past ~10 tools, so these are carefully designed to compose into higher-level workflows.

### `query` — hybrid search

Combines BM25 keyword matching and vector embeddings via Reciprocal Rank Fusion. Supports three sub-query types: `lex` (exact terms), `vec` (semantic meaning), and `hyde` (hypothetical document — describe what the answer looks like).

```json
{
  "searches": [
    {"type": "lex", "query": "taste graph"},
    {"type": "vec", "query": "how design preferences propagate through social networks"}
  ],
  "intent": "research on aesthetic preference modeling"
}
```

~30ms per query. Embeddings via Voyage AI (voyage-4-large, 1024-dim). No OpenAI dependency. Your notes stay on your server — only query text is sent for embedding.

### `get` — read a note

Fuzzy path resolution. Say `"Taste Graph"` instead of `"Resources/Concepts/Taste Graph.md"`. Returns frontmatter (parsed), content, and a content hash for optimistic concurrency on writes.

Resolution order: direct path → strip prefixes → journal date patterns → case-insensitive basename → alias lookup → BM25 fallback.

### `multi_get` — batch read

Read multiple notes by glob pattern or comma-separated list. `"Resources/People/*.md"` returns all people notes. Capped at 50 per request.

### `write_note` — create or update

The part that makes this more than a search engine. Claude creates a note → server validates frontmatter (type, tags, required fields, path/type consistency) → writes to disk → `git add` → `git commit` → synchronous reindex → fire-and-forget embedding → return.

Every write goes through a serialized mutex queue. No concurrent git operations, ever. Optimistic concurrency via content hashing — if the note changed since you last read it, the write is rejected.

```json
{
  "path": "Resources/Concepts/Context Engineering.md",
  "frontmatter": "{\"type\": \"concept\", \"tags\": [\"concept\", \"ai\"]}",
  "content": "The practice of shaping what goes into an LLM's context window..."
}
```

### `list_notes` — browse the vault

Glob-based listing with metadata. Check for duplicates before creating. Get the entity vocabulary for a folder. Scan inbox items.

### `vault_status` — five modes

| Mode | What it does |
|------|-------------|
| `health` | Note count, last commit, vault path |
| `history` | Recent git log, filterable by date and path |
| `diagnostics` | Orphan notes, broken wikilinks, missing frontmatter, stale inbox |
| `graph` | Brandes' centrality, BFS clusters, bridge detection, most-connected hubs |
| `digest` | Lifecycle classification: seeds → sprouts → growing → mature → dormant → withering |

The digest mode is what powers the daily garden practice. It stratifies every note by age, backlink count, word count, and modification recency. Seeds are ideas less than a week old. Withering notes haven't been touched in six months and have almost no connections. The agent surfaces what needs attention without you having to remember what's in the vault.

## Why not the 24 existing Obsidian MCP servers?

There are already [24 Obsidian MCP servers](https://mcp.so) on the registry. Every one of them is:

- **Local-only.** Runs on your laptop, works from that laptop. Open Claude on your phone — nothing.
- **Read-only.** Search and retrieve, but no write-back. Knowledge flows one direction.
- **Flat filesystem.** Treats your vault as a bag of text files. No frontmatter validation, no type system, no vault conventions.

Grove is remote, bidirectional, and opinionated. It treats your vault as a structured knowledge base with rules — types, required fields, path conventions — that agents must respect. It won't let Claude corrupt your vault.

| | Local MCP servers | Grove |
|---|---|---|
| Works from phone/web | No | Yes |
| Write-back | No | Yes, with validation + git commit |
| Search | Keyword or vector | Hybrid BM25 + vector (RRF) |
| Graph analysis | No | Centrality, clusters, lifecycle |
| Auth | None needed | OAuth 2.0 + bearer tokens |
| Scoped sharing | No | Trails — topic-scoped access with deny lists |
| Embeddings | Usually OpenAI API | Voyage AI, your infrastructure |

## The write flow

This is the part I spent the most time getting right. Agents are eager writers and sloppy validators. The write path is intentionally strict:

```
1. Proxy validates bearer token, checks rate limit (20 writes/min)
2. Server validates:
   - Path: no traversal, inside vault, .md only, no symlinks
   - Frontmatter: type in whitelist, required fields present, tags include type
   - Path/type consistency (Resources/Concepts/* must be type:concept)
   - File size < 100KB
   - Optimistic concurrency: if_hash must match the recorded source_hash
3. Write queue (mutex):
   - Write file to disk
   - git add → git commit (with API key identity)
   - Record provenance (path → source_hash + commit_sha)
   - Fire-and-forget: QMD reindex, embed new content
4. Return source_hash + content_hash + commit SHA
5. Batched git push every 30 seconds
```

Server is the sole writer to git. Local machines pull. One direction. No split-brain.

### The two-hash model

The discovery worker mutates notes after they land (it auto-wires wikilinks
based on concept extraction). That makes the on-disk content hash unstable:
a caller that writes content X and receives hash H may find that two seconds
later the file on disk has a different hash, because the worker rewrote links.

Grove solves this with **two hashes** in every write/get response:

- **`source_hash`** — hash of what the caller wrote, pinned to caller intent.
  Stays stable across discovery mutations. **Use this as `if_hash` and
  `If-Match`** for subsequent updates.
- **`content_hash`** — hash of the on-disk content at return time. Equal to
  source_hash immediately after write; may diverge once discovery runs.
  Useful if you specifically care about the current file bytes.

The server validates `if_hash` against the recorded `source_hash` first, and
falls back to the disk hash for files that have no provenance entry yet
(pre-migration notes, or notes created directly by the discovery worker).
The REST API returns `source_hash` as the HTTP `ETag`, so standard
`If-Match` round-trips work correctly.

### Batch writes

For multi-note workflows (creating a cluster of related notes, or chaining
create + update), `write_note` accepts an `operations: []` array executed in
a single mutex acquisition:

```
write_note({
  operations: [
    { path: "a.md", frontmatter: ..., content: "..." },
    { path: "b.md", frontmatter: ..., content: "..." },
    { path: "a.md", frontmatter: ..., content: "...", if_hash_from_op: 0 }
  ],
  atomic: true
})
```

- `if_hash_from_op` chains an op's `if_hash` to an earlier op's `source_hash`
  — no round-trip needed for the intermediate hash.
- `atomic: true` rolls the entire batch back on any failure (git reset +
  provenance restore). `atomic: false` (default) leaves earlier successes
  committed when a later op fails.
- Pre-flight validation runs before the mutex — invalid ops fail fast, no
  partial state.

## Architecture

```
                    ┌──────────────┐
                    │ Auth Proxy   │ :8420
                    │ OAuth + PKCE │
                    │ Rate limiting│
                    │ Audit log    │
                    └──────┬───────┘
                           │
                    ┌──────┴───────┐
                    │ Grove Server │ :8190
                    │ 6 MCP tools  │
                    │ Write queue  │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
       ┌──────┴──┐  ┌─────┴────┐  ┌───┴────┐
       │ QMD     │  │ Voyage   │  │ git    │
       │ BM25    │  │ Vectors  │  │ vault  │
       │ :8177   │  │  (API)   │  │ ~/life │
       └─────────┘  └──────────┘  └────────┘
```

- **TypeScript**, ~7,600 LOC, raw `node:http` (no frameworks)
- **Auth:** OAuth 2.0 with PKCE for Claude.ai custom connectors, bearer tokens for CLI/API
- **Search:** QMD (BM25) + Voyage AI (voyage-4-large embeddings) + RRF fusion
- **Persistence:** Git repo. Every note is a markdown file. Every mutation is a commit.
- **Rate limiting:** 120 reads/min, 20 writes/min per API key. LRU idempotency cache.

## Self-hosting

Grove runs on an AWS t3.medium (~$30/mo). Here's how to deploy your own:

### Prerequisites

- Node.js >= 22
- Git
- A git-tracked Obsidian vault (or any folder of markdown files)
- [QMD](https://github.com/tobi/qmd) for search indexing
- A Voyage AI API key (for vector embeddings, optional — falls back to BM25-only)

### Setup

```bash
git clone https://github.com/jmilinovich/grove.git
cd grove
npm install

# Create an API key
grove keys create my-key
# → grove_live_abc123... (save this, it's shown once)

# Start QMD (search engine)
qmd serve --vault ~/your-vault --port 8177

# Start Grove
npm run proxy
```

### VPS deployment

```bash
# On your VPS:
git clone https://github.com/jmilinovich/grove.git
cd grove && npm install && npm run build

# PM2 for process management
pm2 start dist/proxy.js --name grove-proxy
pm2 start "qmd serve --vault /root/vault --port 8177" --name qmd-server

# Nginx for TLS (use certbot for Let's Encrypt)
# Proxy pass to localhost:8420
```

Vault syncs every 5 minutes via cron. Embeddings are computed on the server via Voyage AI API at index time.

## The garden: how I actually use this

Grove is the infrastructure. The garden is the practice. I have seven Claude skills that compose Grove's six tools into a daily knowledge workflow:

| Skill | What it does | Grove tools used |
|-------|-------------|-----------------|
| `/garden` | Daily review — surfaces seeds, sprouts, withering notes | `vault_status` (digest) |
| `/garden-seek` | Hybrid search across the vault | `query` |
| `/garden-plant` | Create new entity notes with proper scaffolding | `write_note`, `list_notes`, `query` |
| `/garden-harvest` | Extract entities from journal entries, wire up wikilinks | `get`, `multi_get`, `write_note` |
| `/garden-tend` | Vault diagnostics — orphans, broken links, stale inbox | `vault_status` (diagnostics) |
| `/garden-wander` | Random walks on the knowledge graph | `vault_status` (graph), `multi_get` |
| `/garden-forage` | Evaluate bookmarks and promote aligned ones to vault notes | `query`, `write_note` |

The lifecycle: **forage** brings in raw material → **plant** scaffolds new entities → **harvest** extracts connections from journal entries → **garden** surfaces what needs attention → **tend** finds structural issues → **wander** discovers unexpected connections. Knowledge compounds across every conversation.

These skills are [open source](https://github.com/jmilinovich/grove) and designed to be adapted. The pattern generalizes — you don't need my vault structure to use Grove.

## The lineage

```
Obsidian (5M+ users, local-first markdown vaults)
  │
  ├── 24 MCP servers (local-only, read-only, flat filesystem)
  │
  ├── Karpathy's "LLM Knowledge Bases" (Apr 2026)
  │     Context windows + LLM-maintained indices
  │     "There is room for an incredible new product"
  │
  └── Grove (this)
        Remote, bidirectional, vault-aware
        6 structured tools, hybrid search, graph analysis
        Self-hosted, privacy-first, git-native
```

MCP is now an [open standard](https://modelcontextprotocol.io/) under the Linux Foundation, backed by Anthropic, Google, and OpenAI. "Knowledge & Memory" is the largest category in the MCP registry at 283 servers. The protocol is infrastructure, not a fad.

## What's next

- **Multi-vault** — Add a second vault (work knowledge base) with per-vault keys and cross-vault search
- **grove.md** — A hosted version where you connect your GitHub repo and get an MCP endpoint. No VPS required. Cross-client: Claude, ChatGPT, Cursor, anything MCP.
- **Trail portal** — Web dashboard for managing trails, viewing per-trail usage, and a consumer onboarding page with MCP connection instructions
- **Semantic filtering** — LLM judge for trail edge cases where tag/type/path filtering is too coarse (deferred until real edge cases prove the need)

## Trails: scoped sharing

Share slices of your knowledge without exposing the whole vault. A **trail** is a topic-scoped window into your grove — you define what's visible (tags, types, paths) and what's hidden, then hand someone a token. They connect via MCP and see only what the trail allows.

```
┌─────────────────────────────────────────────────────────┐
│                    Your vault (1,000 notes)              │
│                                                         │
│   ┌─────────────┐  ┌──────────────┐  ┌──────────────┐  │
│   │  AI Research │  │   Journal    │  │   Finances   │  │
│   │   trail ✓    │  │   hidden ✗   │  │   hidden ✗   │  │
│   └─────────────┘  └──────────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────────┘
         │
         ▼  trail-scoped token
┌─────────────────────────────────────────────────────────┐
│  Consumer sees: 200 notes on AI, ML, tech, design       │
│  Consumer can't see: journal, health, finances, private │
│  Consumer gets 404 (not 403) for hidden notes           │
└─────────────────────────────────────────────────────────┘
```

### Creating a trail

```bash
grove trails create "AI Research" \
  --allow-tags ai,ml,tech,design \
  --deny-tags private,personal,finance,health \
  --allow-paths "Resources/" \
  --deny-paths "Journal/,Areas/Finances/,Areas/Health/"

# → Trail created: trail_a1b2c3d4
# → Token (shown once, give to consumer):
# →   grove_live_abc123...
```

The token is a standard Grove bearer token, scoped to this trail. Give it to a collaborator, plug it into a Claude custom connector, or use it in any MCP client. They'll never know what they can't see — hidden notes return 404, not 403.

### How tools behave under a trail

Every one of the six MCP tools respects trail scope automatically:

| Tool | Trail behavior |
|------|---------------|
| `query` | Searches the full index for recall, then strips non-trail notes before returning results |
| `get` | Returns 404 for notes outside the trail (doesn't leak that the note exists) |
| `multi_get` | Silently omits non-trail notes from results |
| `list_notes` | Only returns trail-visible notes |
| `write_note` | Constrains writes to trail-allowed paths/tags (if write access is enabled) |
| `vault_status` | Returns scoped stats — note count and types within trail only |

### Filtering model

Trails use a deterministic prefilter — no LLM in the loop, sub-millisecond per note. Filters combine with AND logic:

- **allow_tags** — note must have at least one matching tag
- **deny_tags** — note must NOT have any of these tags
- **allow_types** — note type must be one of these (empty = all types)
- **deny_types** — note type must NOT be one of these
- **allow_paths** — note path must start with one of these prefixes (empty = all paths)
- **deny_paths** — note path must NOT start with any of these prefixes

The test suite verifies 100% precision (zero sensitive notes leak through) and 100% recall (all on-topic notes pass through) on labeled datasets of 20 sensitive and 20 on-topic notes.

### Managing trails

```bash
grove trails                    # list all trails
grove trails disable trail_id   # temporarily disable (consumer gets auth errors)
grove trails delete trail_id    # permanently remove trail + revoke its key
```

Each trail has independent rate limits (default: 60 reads/min, 0 writes/min). All trail access is logged with the trail ID, tool used, total results found, and how many were filtered.

### Consumer setup

Give your consumer the token and the MCP endpoint. That's it:

```json
{
  "mcpServers": {
    "grove": {
      "url": "https://api.grove.md/mcp",
      "headers": { "Authorization": "Bearer grove_live_abc123..." }
    }
  }
}
```

They get the same six tools, same hybrid search, same write validation — just scoped to what you've chosen to share.

## When you don't need Grove

You don't need it if your vault is small enough to paste into a context window. You don't need it if you only use one AI client on one machine. You don't need it if your notes don't have structure worth preserving.

You need it when you want your AI to know who you are regardless of which surface you're talking to it from. When you want knowledge to compound across conversations instead of evaporating. When you have a vault with real structure — types, conventions, connections — and you want agents to respect that structure, not steamroll it.

## License

MIT
