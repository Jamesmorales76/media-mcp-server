# media-mcp

A Model Context Protocol (MCP) server that gives Claude read/write control over a self-hosted media stack. It exposes **78 tools** across seven services through one endpoint.

| Service | Tools | What it covers |
|---|---|---|
| Sonarr | 17 | Search, add, edit and delete series; episodes, queue, missing, calendar, history, quality profiles, root folders, health, disk space |
| Radarr | 16 | The same for movies |
| TrueNAS SCALE | 15 | Pools, datasets, disks, alerts, system info, services (start/stop), snapshots, replication, scrubs, SMART results, network, updates |
| qBittorrent | 10 | Torrent list, pause/resume/delete/recheck, transfer info, speed limits, categories, preferences |
| Plex | 8 | Libraries and contents, sessions, on deck, recently added, search, server info, library refresh |
| Tautulli | 6 | Activity, history, home stats, plays by date, libraries, users |
| Prowlarr | 6 | Indexer search, indexer list and tests, health, system status, history |

## How it was built

1. **Start small.** The first version was a Node.js stdio server running on a Windows laptop, so Claude Desktop could talk to Sonarr and Radarr.
2. **Add services one at a time.** Prowlarr, Plex, Tautulli, qBittorrent and finally TrueNAS were added using each service's own REST API. Sonarr and Radarr use `/api/v3`, Prowlarr uses `/api/v1`.
3. **Move it onto the server.** The stdio server became a containerised HTTP service on the TrueNAS host, using the MCP Streamable HTTP transport in stateless mode (a fresh server instance per request), so any MCP client on the network can connect.
4. **Put it to work.** Claude used it to audit the whole stack: fixing quality upgrade profiles, removing unsuitable indexers, restructuring download paths and tightening connection limits.
5. **Harden and clean up.** A review of the fifth iteration found and fixed several problems:
   - Ten TrueNAS tools were declared twice and nine more were declared with no handler, so calling them returned "Unknown tool". The duplicates and unfinished tools were removed, taking the count from 97 declared to 78 working.
   - The HTTP endpoint had no authentication, so optional bearer-token auth was added.
   - The qBittorrent login now URL-encodes credentials and reports a failed login.
   - TrueNAS TLS verification is now on by default (opt out with `TRUENAS_INSECURE_TLS=true` for self-signed certificates).
   - Duplicate helper functions and dead code were removed.

## Design

- One `TOOLS` array declares every tool and its JSON schema. One `handleTool` switch routes each call to the right service.
- All configuration comes from environment variables. No secrets live in the code.
- Two transports from the same code: `stdio` for Claude Desktop, `http` for a network service (`POST /mcp`, plus `GET /health`).
- Errors from each service are returned as MCP tool errors rather than crashing the server.

## Run it

```bash
npm install
cp .env.example .env     # fill in your URLs and keys
set -a; . ./.env; set +a
npm start                # HTTP on PORT (default 3000)
npm run start:stdio      # stdio mode for Claude Desktop
```

Check it is up: `curl http://localhost:3000/health` (returns the tool count).

With `MCP_AUTH_TOKEN` set, call the MCP endpoint with `Authorization: Bearer <token>`.

## Security

This server can change your media stack and TrueNAS, so treat it like an admin credential.

- Set `MCP_AUTH_TOKEN`. Clients must then send `Authorization: Bearer <token>`. Without it the server logs a warning and `/mcp` is open.
- Keep the port on your LAN or behind a VPN. Do not expose it to the internet.
- Use a TrueNAS API key with the narrowest permissions that work, and avoid `TRUENAS_INSECURE_TLS=true` unless you have a self-signed certificate.
- Never commit `.env`.
