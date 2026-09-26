# NearNow

MCP connector that lets AI assistants (Meta's Muse, Grok, any MCP client) find nearby
public places — pharmacies, supermarkets, gas stations, EV chargers, libraries, post
offices — with honest, attributed opening-hours data from OpenStreetMap.

Spec: `../docs/SPEC-v2.md` · Engineering discipline inherited from `../docs/TECH-v1.md`.

## Run

```bash
npm install
npm run dev            # http://127.0.0.1:8787  (dev mode, no auth)
```

Endpoints:

| Route | What |
|---|---|
| `POST /mcp` | MCP Streamable HTTP (stateless), JSON-RPC |
| `GET /` `/privacy` `/terms` | Static pages (submission requirement: reachable, no login) |
| `GET /icon-512.png` `/favicon.svg` | Icons |
| `GET /healthz` | Health check |

## Test ladder

```bash
npm run smoke        # domain-level: geocode + Overpass + hours (live network)
npm run serve &      # or: PORT=8799 npm run serve
npm run regression   # 10 canonical prompts (data/prompts.json) over MCP — G1 gate
npm run e2e          # protocol checks: initialize/tools/list/tools/call + soft errors
npm run warmup       # W0-14: replay canonical prompts to fill .cache/ (see below)
```

Regression must be 10/10 before any submission or endpoint change (freeze discipline:
during Meta review, `tools/list` stays byte-identical; only data and additive P0 fixes).

## Snapshot backend (Phase 2, ADR-001)

`src/snapshot.ts` serves search/details from the per-state Geofabrik extract in
`data/snapshot/` (CA/TX/NY, ~22k POI nodes, grid index in memory). Live Overpass
stays as fallback for anything the snapshot misses and responses report which
source answered: `meta.source: osm_snapshot | overpass_live` (+ `snapshot_date`).
Disable with `NEARNOW_SNAPSHOT=off`. Weekly rebuild: CI regenerates the extracts
and replaces the `.jsonl` files (see `../c2-pipeline/etl/`). Freeze discipline:
`tools/list` unchanged; this is a data-layer change only.

## Cache warm-up (W0-14, T-day prerequisite)

`npm run warmup` replays the canonical prompts (the `✓` subset: every
`search_places` expecting `OK`, plus a chained `get_place_details` per search)
against a running server, filling `.cache/` so reviewers pasting example
prompts get sub-second answers instead of ~20s cold calls. Scope updates
automatically when PM freezes the submission prompts into `data/prompts.json`.

```bash
npm run serve &                                   # local
npm run warmup                                    # warm local .cache/
NEARNOW_URL=https://mcp.locafact.com/nearnow/mcp \
NEARNOW_API_KEY=<prod key> npm run warmup         # warm production
```

Scheduling: production warm-up runs as a **Cloudflare Cron Trigger**
(`0 * * * *`) whose scheduled handler replays the frozen prompts via internal
fetch — no HTTP auth hop, no repo secrets. Deployed and registered (verified
via the Cloudflare API).

## Auth & config (env)

| Var | Meaning |
|---|---|
| `PORT` | listen port (default 8787) |
| `NEARNOW_API_KEYS` | comma-separated API keys; unset = dev mode (no auth) |
| `NEARNOW_ALLOWED_ORIGINS` | comma-separated Origin allowlist; unset = allow all |

## Data curation

- `data/chain-hours.json` — chain-standard hours. Only `verified: true` rules are ever
  applied (reported as `estimated`). Unverified brands stay inert until checked against an
  official source; put the source and check date in the entry.
- `data/prompts.json` — canonical example prompts + assertions; the `✓` subset becomes the
  muse.ai/platform submission text.

## Hour-evaluation gotcha (do not "simplify" this)

`opening_hours` evaluates Dates in the **system** timezone. `src/hours.ts` therefore feeds
it a fake Date whose local components equal the POI's US-Pacific wall clock and converts
`next_change` back to real instants (`toReal`). Verified against a live PT clock; see
SPEC-v2 §11.

## Deploy (W3)

Any Node 22+ host in a US region. `Dockerfile` included. Behind the connector:

1. Cloudflare Workers (deployed): `esbuild` bundle ~926 KiB gzip, `nodejs_compat`;
   `NEARNOW_API_KEYS` set as a Worker secret (auth on, healthz stays open)
2. Custom domain: `https://mcp.locafact.com/nearnow/mcp` (Worker Routes, TLS auto-issued)
3. Point muse.ai/platform and any MCP client at `https://mcp.locafact.com/nearnow/mcp`

Network notes: Overpass WAF rejects curl's default fingerprint — all upstream calls use
Node fetch with a dedicated User-Agent (hardcoded in `src/overpass.ts` / `src/geocode.ts`).
Cache lives in `.cache/` (7-day TTL); a Cloudflare Cron Trigger warms the cache hourly (deployed)
(uncached Overpass queries can take up to ~20s; cached responses answer in under a second).
