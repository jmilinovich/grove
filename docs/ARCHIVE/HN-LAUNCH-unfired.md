# HN Launch Plan

Updated 2026-04-13. Ready to post.

## Title

```
Show HN: Grove – Open-source MCP server that makes your Obsidian vault accessible from any AI client
```

## Post body

Grove is an open-source MCP server that wraps a git-tracked Obsidian vault (or any folder of markdown files) and exposes it as six structured tools — search, read, batch read, write, list, and vault status. Any MCP-compatible client connects to one URL and gets full access to your knowledge base.

There are already 24 Obsidian MCP servers on the registry. Every one of them is local-only: runs on your laptop, works from that laptop. Open Claude on your phone — nothing. They're also read-only and treat your vault as a bag of text files.

Grove is remote, bidirectional, and opinionated:

- Hybrid search (BM25 + Voyage AI vectors, fused with RRF) — ~30ms queries
- Write-back with frontmatter validation, path/type consistency checks, and optimistic concurrency
- Every write is a git commit with the API key identity in the message
- Trails — scoped sharing windows so you can expose slices of your vault without showing the whole thing
- Graph analysis — centrality, clusters, lifecycle classification (seeds → sprouts → growing → mature → dormant → withering)

~7,600 LOC TypeScript, raw node:http (no frameworks), 228 tests. Runs on an AWS t3.medium for ~$30/mo.

README with architecture, self-hosting guide, and the garden workflow: https://github.com/jmilinovich/grove

## Author comment (post immediately after submission)

I built this because I keep my life in an Obsidian vault — ~1,000 notes, journal entries going back years, concept notes, people, recipes, a financial plan. I had Claude skills that could search and write to it, but only from my laptop, only in Claude Code, only when the local search server was running.

Then I opened Claude on my phone during a conversation and realized: it had no idea who I was. Every concept, every person, every connection — gone.

So I put the search engine on a server. Added auth. Added write-back with strict validation so agents couldn't corrupt the vault. Added a graph analyzer so Claude could understand the shape of my knowledge, not just keyword-match against it.

Three weeks in, I haven't manually searched my own notes once. Claude finds what I need in ~30ms from any surface. When it learns something new in a conversation, it plants it back. The knowledge compounds.

The deeper thesis: MCP is now an open standard under the Linux Foundation, backed by Anthropic, Google, and OpenAI. "Knowledge & Memory" is the largest category in the MCP registry at 283 servers. But almost all of them are local-only. The gap isn't more note-taking apps — it's the infrastructure layer that makes your existing knowledge base accessible from every AI surface you use.

Karpathy's recent thread on LLM Knowledge Bases described exactly this problem: "I think there is room here for an incredible new product instead of a hacky collection of scripts." Grove is my attempt at the infrastructure for that product.

Happy to answer questions about the architecture, the search tuning, or the trail system. The README has the full self-hosting guide — you can have this running on a VPS in about 15 minutes.

## Timing

Tue/Wed 8–9am ET (5–6am PT). Weekday mornings when east coast devs are scanning.

## Post-submission checklist

- [ ] Post at target time
- [ ] Drop author comment within 60 seconds
- [ ] Reply to every comment in first 2 hours
- [ ] Have the repo README, self-hosting section, and garden workflow polished
- [ ] Make sure `grove keys create` and `npm run proxy` work cleanly from a fresh clone
