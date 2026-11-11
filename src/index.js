#!/usr/bin/env node
/**
 * media-mcp — Full control MCP server
 * Sonarr · Radarr · Prowlarr · Plex · Tautulli · qBittorrent · TrueNAS SCALE
 */

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { createMcpExpressApp } = require("@modelcontextprotocol/sdk/server/express.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");
const axios = require("axios");

// ── Config ────────────────────────────────────────────────────────────────────
const cfg = {
  sonarr:      { url: process.env.SONARR_URL,      key: process.env.SONARR_API_KEY },
  radarr:      { url: process.env.RADARR_URL,      key: process.env.RADARR_API_KEY },
  prowlarr:    { url: process.env.PROWLARR_URL,     key: process.env.PROWLARR_API_KEY },
  plex:        { url: process.env.PLEX_URL,         token: process.env.PLEX_TOKEN },
  tautulli:    { url: process.env.TAUTULLI_URL,     key: process.env.TAUTULLI_API_KEY },
  qb:          { url: process.env.QBITTORRENT_URL,  user: process.env.QB_USERNAME, pass: process.env.QB_PASSWORD },
  truenas:     { url: process.env.TRUENAS_URL,      key: process.env.TRUENAS_API_KEY },
  port:        parseInt(process.env.PORT || "3000"),
  authToken:   process.env.MCP_AUTH_TOKEN,   // optional bearer token for the HTTP endpoint
  mode:        process.env.TRANSPORT || "http",   // "http" or "stdio"
};

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function arrGet(base, key, path, params = {}) {
  return axios.get(`${base}${path}`, {
    headers: { "X-Api-Key": key },
    params,
    timeout: 15000,
  }).then(r => r.data);
}

function arrPost(base, key, path, data = {}) {
  return axios.post(`${base}${path}`, data, {
    headers: { "X-Api-Key": key, "Content-Type": "application/json" },
    timeout: 15000,
  }).then(r => r.data);
}

function arrDelete(base, key, path, params = {}) {
  return axios.delete(`${base}${path}`, {
    headers: { "X-Api-Key": key },
    params,
    timeout: 15000,
  }).then(r => r.data);
}

// qBittorrent keeps a cookie session
let qbCookie = null;
async function qbLogin() {
  const r = await axios.post(
    `${cfg.qb.url}/api/v2/auth/login`,
    new URLSearchParams({ username: cfg.qb.user, password: cfg.qb.pass }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, withCredentials: true }
  );
  if (typeof r.data === "string" && r.data.trim() === "Fails.") {
    throw new Error("qBittorrent login failed: check QB_USERNAME / QB_PASSWORD");
  }
  const setCookie = r.headers["set-cookie"];
  if (setCookie) qbCookie = setCookie[0].split(";")[0];
  return qbCookie;
}

async function qbGet(path, params = {}) {
  if (!qbCookie) await qbLogin();
  return axios.get(`${cfg.qb.url}/api/v2${path}`, {
    headers: { Cookie: qbCookie },
    params,
    timeout: 15000,
  }).then(r => r.data);
}

async function qbPost(path, data = "") {
  if (!qbCookie) await qbLogin();
  return axios.post(`${cfg.qb.url}/api/v2${path}`, data, {
    headers: { Cookie: qbCookie, "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15000,
  }).then(r => r.data);
}

function plexGet(path, params = {}) {
  return axios.get(`${cfg.plex.url}${path}`, {
    headers: { "X-Plex-Token": cfg.plex.token, Accept: "application/json" },
    params,
    timeout: 15000,
  }).then(r => r.data);
}

function tautulliGet(cmd, params = {}) {
  return axios.get(`${cfg.tautulli.url}/api/v2`, {
    params: { apikey: cfg.tautulli.key, cmd, ...params },
    timeout: 15000,
  }).then(r => r.data?.response?.data);
}

// TrueNAS often uses a self-signed certificate. Set TRUENAS_INSECURE_TLS=true to skip verification.
const tnAgent = new (require("https").Agent)({ rejectUnauthorized: process.env.TRUENAS_INSECURE_TLS !== "true" });

function tnGet(path, params = {}) {
  return axios.get(`${cfg.truenas.url}/api/v2.0${path}`, {
    headers: { Authorization: `Bearer ${cfg.truenas.key}` },
    params,
    timeout: 15000,
    httpsAgent: tnAgent,
  }).then(r => r.data);
}

function tnPost(path, data = {}) {
  return axios.post(`${cfg.truenas.url}/api/v2.0${path}`, data, {
    headers: { Authorization: `Bearer ${cfg.truenas.key}`, "Content-Type": "application/json" },
    timeout: 15000,
    httpsAgent: tnAgent,
  }).then(r => r.data);
}


function ok(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}
function txt(str) {
  return { content: [{ type: "text", text: String(str) }] };
}
function err(e) {
  const msg = e?.response?.data ? JSON.stringify(e.response.data) : e.message;
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS = [
  // ── Sonarr ────────────────────────────────────────────────────────────────
  {
    name: "sonarr_get_series",
    description: "List all TV series in Sonarr, or get details for a specific series by ID.",
    inputSchema: {
      type: "object",
      properties: {
        series_id: { type: "number", description: "Optional series ID for a single series" }
      }
    }
  },
  {
    name: "sonarr_lookup_series",
    description: "Search for a TV series to add to Sonarr (does not add it, just looks up).",
    inputSchema: {
      type: "object",
      properties: { term: { type: "string" } },
      required: ["term"]
    }
  },
  {
    name: "sonarr_add_series",
    description: "Add a TV series to Sonarr for monitoring and downloading.",
    inputSchema: {
      type: "object",
      properties: {
        tvdb_id:          { type: "number", description: "TVDB ID from sonarr_lookup_series" },
        title:            { type: "string" },
        quality_profile_id: { type: "number", description: "Quality profile ID (use sonarr_get_quality_profiles)" },
        root_folder_path: { type: "string", description: "Root folder, e.g. /mnt/TV" },
        monitored:        { type: "boolean", default: true },
        season_folder:    { type: "boolean", default: true },
        search_for_missing_episodes: { type: "boolean", default: true }
      },
      required: ["tvdb_id", "title", "quality_profile_id", "root_folder_path"]
    }
  },
  {
    name: "sonarr_delete_series",
    description: "Delete a series from Sonarr.",
    inputSchema: {
      type: "object",
      properties: {
        series_id:    { type: "number" },
        delete_files: { type: "boolean", default: false }
      },
      required: ["series_id"]
    }
  },
  {
    name: "sonarr_get_episodes",
    description: "Get all episodes for a series.",
    inputSchema: {
      type: "object",
      properties: { series_id: { type: "number" } },
      required: ["series_id"]
    }
  },
  {
    name: "sonarr_search_episodes",
    description: "Trigger an episode search/download in Sonarr.",
    inputSchema: {
      type: "object",
      properties: {
        episode_ids: { type: "array", items: { type: "number" }, description: "Episode IDs to search for" }
      },
      required: ["episode_ids"]
    }
  },
  {
    name: "sonarr_get_queue",
    description: "Get the current Sonarr download queue.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "sonarr_remove_queue_item",
    description: "Remove an item from the Sonarr queue.",
    inputSchema: {
      type: "object",
      properties: {
        id:           { type: "number" },
        blacklist:    { type: "boolean", default: false },
        remove_from_client: { type: "boolean", default: true }
      },
      required: ["id"]
    }
  },
  {
    name: "sonarr_get_quality_profiles",
    description: "List quality profiles in Sonarr.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "sonarr_get_root_folders",
    description: "List root folders configured in Sonarr.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "sonarr_get_calendar",
    description: "Get upcoming episode air dates.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", default: 7, description: "Number of days ahead" }
      }
    }
  },
  {
    name: "sonarr_get_history",
    description: "Get Sonarr download history.",
    inputSchema: {
      type: "object",
      properties: {
        page:      { type: "number", default: 1 },
        page_size: { type: "number", default: 20 }
      }
    }
  },
  {
    name: "sonarr_get_system_status",
    description: "Get Sonarr system status and version.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "sonarr_get_health",
    description: "Get Sonarr health check results.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "sonarr_get_disk_space",
    description: "Get disk space info from Sonarr.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "sonarr_get_missing",
    description: "Get missing episodes that Sonarr is monitoring but hasn't downloaded.",
    inputSchema: {
      type: "object",
      properties: { page_size: { type: "number", default: 20 } }
    }
  },
  {
    name: "sonarr_edit_series",
    description: "Edit an existing series in Sonarr (monitored, quality profile, path, tags, etc).",
    inputSchema: {
      type: "object",
      properties: {
        series_id:          { type: "number" },
        monitored:          { type: "boolean" },
        quality_profile_id: { type: "number" },
        path:               { type: "string" }
      },
      required: ["series_id"]
    }
  },

  // ── Radarr ────────────────────────────────────────────────────────────────
  {
    name: "radarr_get_movies",
    description: "List all movies in Radarr.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "radarr_lookup_movie",
    description: "Search for a movie to add to Radarr (lookup only, does not add).",
    inputSchema: {
      type: "object",
      properties: { term: { type: "string" } },
      required: ["term"]
    }
  },
  {
    name: "radarr_add_movie",
    description: "Add a movie to Radarr for monitoring and downloading.",
    inputSchema: {
      type: "object",
      properties: {
        tmdb_id:            { type: "number", description: "TMDB ID from radarr_lookup_movie" },
        title:              { type: "string" },
        year:               { type: "number" },
        quality_profile_id: { type: "number" },
        root_folder_path:   { type: "string", description: "e.g. /mnt/Movies" },
        monitored:          { type: "boolean", default: true },
        search_for_movie:   { type: "boolean", default: true }
      },
      required: ["tmdb_id", "title", "quality_profile_id", "root_folder_path"]
    }
  },
  {
    name: "radarr_delete_movie",
    description: "Delete a movie from Radarr.",
    inputSchema: {
      type: "object",
      properties: {
        movie_id:     { type: "number" },
        delete_files: { type: "boolean", default: false },
        add_exclusion: { type: "boolean", default: false }
      },
      required: ["movie_id"]
    }
  },
  {
    name: "radarr_search_movie",
    description: "Trigger a download search for a movie already in Radarr.",
    inputSchema: {
      type: "object",
      properties: { movie_ids: { type: "array", items: { type: "number" } } },
      required: ["movie_ids"]
    }
  },
  {
    name: "radarr_get_queue",
    description: "Get the current Radarr download queue.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "radarr_remove_queue_item",
    description: "Remove an item from the Radarr queue.",
    inputSchema: {
      type: "object",
      properties: {
        id:           { type: "number" },
        blacklist:    { type: "boolean", default: false },
        remove_from_client: { type: "boolean", default: true }
      },
      required: ["id"]
    }
  },
  {
    name: "radarr_get_quality_profiles",
    description: "List quality profiles in Radarr.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "radarr_get_root_folders",
    description: "List root folders configured in Radarr.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "radarr_get_calendar",
    description: "Get upcoming movie releases in Radarr.",
    inputSchema: {
      type: "object",
      properties: { days: { type: "number", default: 30 } }
    }
  },
  {
    name: "radarr_get_history",
    description: "Get Radarr download history.",
    inputSchema: {
      type: "object",
      properties: {
        page:      { type: "number", default: 1 },
        page_size: { type: "number", default: 20 }
      }
    }
  },
  {
    name: "radarr_get_system_status",
    description: "Get Radarr system status and version.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "radarr_get_health",
    description: "Get Radarr health check results.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "radarr_get_disk_space",
    description: "Get disk space info from Radarr.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "radarr_get_missing",
    description: "Get movies that are monitored but not yet downloaded.",
    inputSchema: {
      type: "object",
      properties: { page_size: { type: "number", default: 20 } }
    }
  },
  {
    name: "radarr_edit_movie",
    description: "Edit an existing movie in Radarr.",
    inputSchema: {
      type: "object",
      properties: {
        movie_id:           { type: "number" },
        monitored:          { type: "boolean" },
        quality_profile_id: { type: "number" },
        path:               { type: "string" }
      },
      required: ["movie_id"]
    }
  },

  // ── Prowlarr ──────────────────────────────────────────────────────────────
  {
    name: "prowlarr_search",
    description: "Search all indexers via Prowlarr.",
    inputSchema: {
      type: "object",
      properties: {
        query:  { type: "string" },
        limit:  { type: "number", default: 20 },
        offset: { type: "number", default: 0 }
      },
      required: ["query"]
    }
  },
  {
    name: "prowlarr_get_indexers",
    description: "List all indexers configured in Prowlarr.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "prowlarr_get_health",
    description: "Get Prowlarr health check results.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "prowlarr_get_system_status",
    description: "Get Prowlarr system status.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "prowlarr_test_indexer",
    description: "Test a specific Prowlarr indexer.",
    inputSchema: {
      type: "object",
      properties: { indexer_id: { type: "number" } },
      required: ["indexer_id"]
    }
  },
  {
    name: "prowlarr_get_history",
    description: "Get Prowlarr search/grab history.",
    inputSchema: {
      type: "object",
      properties: {
        page:      { type: "number", default: 1 },
        page_size: { type: "number", default: 20 }
      }
    }
  },

  // ── qBittorrent ───────────────────────────────────────────────────────────
  {
    name: "qb_get_torrents",
    description: "List all torrents in qBittorrent.",
    inputSchema: {
      type: "object",
      properties: {
        filter:   { type: "string", description: "all | downloading | seeding | completed | paused | errored | stalled" },
        category: { type: "string" },
        sort:     { type: "string", description: "name | size | progress | dlspeed | upspeed | ratio | added_on" }
      }
    }
  },
  {
    name: "qb_get_transfer_info",
    description: "Get global qBittorrent transfer speeds and totals.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "qb_pause_torrents",
    description: "Pause one or more torrents. Use hashes='all' to pause everything.",
    inputSchema: {
      type: "object",
      properties: {
        hashes: { type: "string", description: "Torrent hash(es) pipe-separated, or 'all'" }
      },
      required: ["hashes"]
    }
  },
  {
    name: "qb_resume_torrents",
    description: "Resume one or more torrents. Use hashes='all' to resume everything.",
    inputSchema: {
      type: "object",
      properties: {
        hashes: { type: "string", description: "Torrent hash(es) pipe-separated, or 'all'" }
      },
      required: ["hashes"]
    }
  },
  {
    name: "qb_delete_torrents",
    description: "Delete torrents from qBittorrent, optionally deleting files too.",
    inputSchema: {
      type: "object",
      properties: {
        hashes:       { type: "string", description: "Pipe-separated hashes" },
        delete_files: { type: "boolean", default: false }
      },
      required: ["hashes"]
    }
  },
  {
    name: "qb_set_download_limit",
    description: "Set global download speed limit in bytes/s (0 = unlimited).",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number" } },
      required: ["limit"]
    }
  },
  {
    name: "qb_set_upload_limit",
    description: "Set global upload speed limit in bytes/s (0 = unlimited).",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number" } },
      required: ["limit"]
    }
  },
  {
    name: "qb_get_categories",
    description: "List all categories in qBittorrent.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "qb_recheck_torrents",
    description: "Force recheck/rehash torrents.",
    inputSchema: {
      type: "object",
      properties: { hashes: { type: "string" } },
      required: ["hashes"]
    }
  },
  {
    name: "qb_get_preferences",
    description: "Get qBittorrent application preferences.",
    inputSchema: { type: "object", properties: {} }
  },

  // ── Plex ──────────────────────────────────────────────────────────────────
  {
    name: "plex_get_libraries",
    description: "List all Plex libraries (Movies, TV Shows, Music, etc).",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "plex_get_library_contents",
    description: "Get contents of a Plex library section.",
    inputSchema: {
      type: "object",
      properties: {
        section_key: { type: "string", description: "Library section key from plex_get_libraries" },
        limit:       { type: "number", default: 50 }
      },
      required: ["section_key"]
    }
  },
  {
    name: "plex_get_sessions",
    description: "Get active Plex streaming sessions.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "plex_get_on_deck",
    description: "Get Plex On Deck (continue watching) items.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "plex_get_recently_added",
    description: "Get recently added items across all Plex libraries.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", default: 20 } }
    }
  },
  {
    name: "plex_search",
    description: "Search Plex for media by title.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"]
    }
  },
  {
    name: "plex_get_server_info",
    description: "Get Plex server info, version, and capabilities.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "plex_refresh_library",
    description: "Trigger a Plex library scan/refresh.",
    inputSchema: {
      type: "object",
      properties: { section_key: { type: "string" } },
      required: ["section_key"]
    }
  },

  // ── Tautulli ──────────────────────────────────────────────────────────────
  {
    name: "tautulli_get_activity",
    description: "Get current Tautulli streaming activity.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "tautulli_get_history",
    description: "Get Tautulli watch history.",
    inputSchema: {
      type: "object",
      properties: {
        length:   { type: "number", default: 25 },
        user:     { type: "string" },
        media_type: { type: "string", description: "movie | episode | track" }
      }
    }
  },
  {
    name: "tautulli_get_home_stats",
    description: "Get Tautulli home stats: most watched, top users, etc.",
    inputSchema: {
      type: "object",
      properties: {
        time_range: { type: "number", default: 30, description: "Days" },
        stats_count: { type: "number", default: 5 }
      }
    }
  },
  {
    name: "tautulli_get_libraries",
    description: "Get Tautulli library stats.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "tautulli_get_users",
    description: "List all users in Tautulli.",
    inputSchema: { type: "object", properties: {} }
  },
  // ── TrueNAS SCALE ─────────────────────────────────────────────────────────
  {
    name: "truenas_get_pools",
    description: "Get ZFS pool status, health, and usage on TrueNAS SCALE.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "truenas_get_datasets",
    description: "List ZFS datasets with used/available space. Optionally filter by pool name.",
    inputSchema: {
      type: "object",
      properties: {
        pool: { type: "string", description: "Filter by pool name (optional)" }
      }
    }
  },
  {
    name: "truenas_get_disks",
    description: "List all disks on TrueNAS with model, size, serial, and temperature.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "truenas_get_alerts",
    description: "Get active TrueNAS system alerts.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "truenas_get_system_info",
    description: "Get TrueNAS system info: hostname, version, uptime, CPU, memory.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "truenas_get_services",
    description: "List all TrueNAS services (SMB, NFS, SSH, etc.) and their running state.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "truenas_start_service",
    description: "Start a TrueNAS service.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service name e.g. smb, nfs, ssh, cifs" }
      },
      required: ["service"]
    }
  },
  {
    name: "truenas_stop_service",
    description: "Stop a TrueNAS service.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service name e.g. smb, nfs, ssh" }
      },
      required: ["service"]
    }
  },
  {
    name: "truenas_get_snapshots",
    description: "List ZFS snapshots, optionally filtered by dataset.",
    inputSchema: {
      type: "object",
      properties: {
        dataset: { type: "string", description: "Dataset name to filter snapshots (optional)" },
        limit: { type: "number", default: 20 }
      }
    }
  },
  {
    name: "truenas_get_replication_tasks",
    description: "List TrueNAS replication tasks and their last run status.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "truenas_get_scrub_tasks",
    description: "List ZFS scrub tasks and their status.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "truenas_run_scrub",
    description: "Start a ZFS scrub on a pool.",
    inputSchema: {
      type: "object",
      properties: {
        pool: { type: "string", description: "Pool name to scrub" }
      },
      required: ["pool"]
    }
  },
  {
    name: "truenas_get_smart_results",
    description: "Get S.M.A.R.T. test results for disks.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "truenas_get_network_interfaces",
    description: "List TrueNAS network interfaces with IP addresses and status.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "truenas_get_update_status",
    description: "Check if TrueNAS updates are available.",
    inputSchema: { type: "object", properties: {} }
  },

  {
    name: "tautulli_get_plays_by_date",
    description: "Get Tautulli play counts by date.",
    inputSchema: {
      type: "object",
      properties: {
        time_range: { type: "number", default: 30 },
        y_axis:     { type: "string", default: "plays", description: "plays | duration" }
      }
    }
  },

  // ── TrueNAS SCALE ─────────────────────────────────────────────────────────
  ];

// ── Tool handlers ─────────────────────────────────────────────────────────────
async function handleTool(name, args) {
  switch (name) {
    // Sonarr
    case "sonarr_get_series":
      return ok(await arrGet(cfg.sonarr.url, cfg.sonarr.key,
        args.series_id ? `/api/v3/series/${args.series_id}` : "/api/v3/series"));

    case "sonarr_lookup_series":
      return ok(await arrGet(cfg.sonarr.url, cfg.sonarr.key, "/api/v3/series/lookup", { term: args.term }));

    case "sonarr_add_series": {
      const payload = {
        tvdbId: args.tvdb_id,
        title: args.title,
        qualityProfileId: args.quality_profile_id,
        rootFolderPath: args.root_folder_path,
        monitored: args.monitored !== false,
        seasonFolder: args.season_folder !== false,
        addOptions: { searchForMissingEpisodes: args.search_for_missing_episodes !== false },
        seasons: [],
      };
      return ok(await arrPost(cfg.sonarr.url, cfg.sonarr.key, "/api/v3/series", payload));
    }

    case "sonarr_delete_series":
      return ok(await arrDelete(cfg.sonarr.url, cfg.sonarr.key, `/api/v3/series/${args.series_id}`,
        { deleteFiles: args.delete_files || false }));

    case "sonarr_get_episodes":
      return ok(await arrGet(cfg.sonarr.url, cfg.sonarr.key, "/api/v3/episode", { seriesId: args.series_id }));

    case "sonarr_search_episodes":
      return ok(await arrPost(cfg.sonarr.url, cfg.sonarr.key, "/api/v3/command",
        { name: "EpisodeSearch", episodeIds: args.episode_ids }));

    case "sonarr_get_queue":
      return ok(await arrGet(cfg.sonarr.url, cfg.sonarr.key, "/api/v3/queue", { pageSize: 50 }));

    case "sonarr_remove_queue_item":
      return ok(await arrDelete(cfg.sonarr.url, cfg.sonarr.key, `/api/v3/queue/${args.id}`,
        { blacklist: args.blacklist || false, removeFromClient: args.remove_from_client !== false }));

    case "sonarr_get_quality_profiles":
      return ok(await arrGet(cfg.sonarr.url, cfg.sonarr.key, "/api/v3/qualityprofile"));

    case "sonarr_get_root_folders":
      return ok(await arrGet(cfg.sonarr.url, cfg.sonarr.key, "/api/v3/rootfolder"));

    case "sonarr_get_calendar": {
      const start = new Date().toISOString();
      const end = new Date(Date.now() + (args.days || 7) * 86400000).toISOString();
      return ok(await arrGet(cfg.sonarr.url, cfg.sonarr.key, "/api/v3/calendar", { start, end }));
    }

    case "sonarr_get_history":
      return ok(await arrGet(cfg.sonarr.url, cfg.sonarr.key, "/api/v3/history",
        { page: args.page || 1, pageSize: args.page_size || 20 }));

    case "sonarr_get_system_status":
      return ok(await arrGet(cfg.sonarr.url, cfg.sonarr.key, "/api/v3/system/status"));

    case "sonarr_get_health":
      return ok(await arrGet(cfg.sonarr.url, cfg.sonarr.key, "/api/v3/health"));

    case "sonarr_get_disk_space":
      return ok(await arrGet(cfg.sonarr.url, cfg.sonarr.key, "/api/v3/diskspace"));

    case "sonarr_get_missing":
      return ok(await arrGet(cfg.sonarr.url, cfg.sonarr.key, "/api/v3/wanted/missing",
        { pageSize: args.page_size || 20 }));

    case "sonarr_edit_series": {
      const existing = await arrGet(cfg.sonarr.url, cfg.sonarr.key, `/api/v3/series/${args.series_id}`);
      const updated = {
        ...existing,
        ...(args.monitored !== undefined && { monitored: args.monitored }),
        ...(args.quality_profile_id && { qualityProfileId: args.quality_profile_id }),
        ...(args.path && { path: args.path }),
      };
      return ok(await axios.put(`${cfg.sonarr.url}/api/v3/series/${args.series_id}`, updated,
        { headers: { "X-Api-Key": cfg.sonarr.key } }).then(r => r.data));
    }

    // Radarr
    case "radarr_get_movies":
      return ok(await arrGet(cfg.radarr.url, cfg.radarr.key, "/api/v3/movie"));

    case "radarr_lookup_movie":
      return ok(await arrGet(cfg.radarr.url, cfg.radarr.key, "/api/v3/movie/lookup", { term: args.term }));

    case "radarr_add_movie": {
      const payload = {
        tmdbId: args.tmdb_id,
        title: args.title,
        year: args.year,
        qualityProfileId: args.quality_profile_id,
        rootFolderPath: args.root_folder_path,
        monitored: args.monitored !== false,
        addOptions: { searchForMovie: args.search_for_movie !== false },
      };
      return ok(await arrPost(cfg.radarr.url, cfg.radarr.key, "/api/v3/movie", payload));
    }

    case "radarr_delete_movie":
      return ok(await arrDelete(cfg.radarr.url, cfg.radarr.key, `/api/v3/movie/${args.movie_id}`,
        { deleteFiles: args.delete_files || false, addImportExclusion: args.add_exclusion || false }));

    case "radarr_search_movie":
      return ok(await arrPost(cfg.radarr.url, cfg.radarr.key, "/api/v3/command",
        { name: "MoviesSearch", movieIds: args.movie_ids }));

    case "radarr_get_queue":
      return ok(await arrGet(cfg.radarr.url, cfg.radarr.key, "/api/v3/queue", { pageSize: 50 }));

    case "radarr_remove_queue_item":
      return ok(await arrDelete(cfg.radarr.url, cfg.radarr.key, `/api/v3/queue/${args.id}`,
        { blacklist: args.blacklist || false, removeFromClient: args.remove_from_client !== false }));

    case "radarr_get_quality_profiles":
      return ok(await arrGet(cfg.radarr.url, cfg.radarr.key, "/api/v3/qualityprofile"));

    case "radarr_get_root_folders":
      return ok(await arrGet(cfg.radarr.url, cfg.radarr.key, "/api/v3/rootfolder"));

    case "radarr_get_calendar": {
      const start = new Date().toISOString();
      const end = new Date(Date.now() + (args.days || 30) * 86400000).toISOString();
      return ok(await arrGet(cfg.radarr.url, cfg.radarr.key, "/api/v3/calendar", { start, end }));
    }

    case "radarr_get_history":
      return ok(await arrGet(cfg.radarr.url, cfg.radarr.key, "/api/v3/history",
        { page: args.page || 1, pageSize: args.page_size || 20 }));

    case "radarr_get_system_status":
      return ok(await arrGet(cfg.radarr.url, cfg.radarr.key, "/api/v3/system/status"));

    case "radarr_get_health":
      return ok(await arrGet(cfg.radarr.url, cfg.radarr.key, "/api/v3/health"));

    case "radarr_get_disk_space":
      return ok(await arrGet(cfg.radarr.url, cfg.radarr.key, "/api/v3/diskspace"));

    case "radarr_get_missing":
      return ok(await arrGet(cfg.radarr.url, cfg.radarr.key, "/api/v3/movie",
        { monitored: true, hasFile: false }));

    case "radarr_edit_movie": {
      const existing = await arrGet(cfg.radarr.url, cfg.radarr.key, `/api/v3/movie/${args.movie_id}`);
      const updated = {
        ...existing,
        ...(args.monitored !== undefined && { monitored: args.monitored }),
        ...(args.quality_profile_id && { qualityProfileId: args.quality_profile_id }),
        ...(args.path && { path: args.path }),
      };
      return ok(await axios.put(`${cfg.radarr.url}/api/v3/movie/${args.movie_id}`, updated,
        { headers: { "X-Api-Key": cfg.radarr.key } }).then(r => r.data));
    }

    // Prowlarr
    case "prowlarr_search":
      return ok(await arrGet(cfg.prowlarr.url, cfg.prowlarr.key, "/api/v1/search",
        { query: args.query, indexerIds: [0], type: "search", limit: args.limit || 20, offset: args.offset || 0 }));

    case "prowlarr_get_indexers":
      return ok(await arrGet(cfg.prowlarr.url, cfg.prowlarr.key, "/api/v1/indexer"));

    case "prowlarr_get_health":
      return ok(await arrGet(cfg.prowlarr.url, cfg.prowlarr.key, "/api/v1/health"));

    case "prowlarr_get_system_status":
      return ok(await arrGet(cfg.prowlarr.url, cfg.prowlarr.key, "/api/v1/system/status"));

    case "prowlarr_test_indexer":
      return ok(await arrPost(cfg.prowlarr.url, cfg.prowlarr.key, `/api/v1/indexer/test/${args.indexer_id}`));

    case "prowlarr_get_history":
      return ok(await arrGet(cfg.prowlarr.url, cfg.prowlarr.key, "/api/v1/history",
        { page: args.page || 1, pageSize: args.page_size || 20 }));

    // qBittorrent
    case "qb_get_torrents":
      return ok(await qbGet("/torrents/info",
        { filter: args.filter || "all", category: args.category, sort: args.sort }));

    case "qb_get_transfer_info":
      return ok(await qbGet("/transfer/info"));

    case "qb_pause_torrents":
      return txt(await qbPost("/torrents/pause", `hashes=${args.hashes}`));

    case "qb_resume_torrents":
      return txt(await qbPost("/torrents/resume", `hashes=${args.hashes}`));

    case "qb_delete_torrents":
      return txt(await qbPost("/torrents/delete",
        `hashes=${args.hashes}&deleteFiles=${args.delete_files ? "true" : "false"}`));

    case "qb_set_download_limit":
      return txt(await qbPost("/transfer/setDownloadLimit", `limit=${args.limit}`));

    case "qb_set_upload_limit":
      return txt(await qbPost("/transfer/setUploadLimit", `limit=${args.limit}`));

    case "qb_get_categories":
      return ok(await qbGet("/torrents/categories"));

    case "qb_recheck_torrents":
      return txt(await qbPost("/torrents/recheck", `hashes=${args.hashes}`));

    case "qb_get_preferences":
      return ok(await qbGet("/app/preferences"));

    // Plex
    case "plex_get_libraries": {
      const data = await plexGet("/library/sections");
      return ok(data?.MediaContainer?.Directory || data);
    }

    case "plex_get_library_contents": {
      const data = await plexGet(`/library/sections/${args.section_key}/all`,
        { "X-Plex-Container-Size": args.limit || 50 });
      return ok(data?.MediaContainer?.Metadata || data);
    }

    case "plex_get_sessions": {
      const data = await plexGet("/status/sessions");
      return ok(data?.MediaContainer?.Metadata || []);
    }

    case "plex_get_on_deck": {
      const data = await plexGet("/library/onDeck");
      return ok(data?.MediaContainer?.Metadata || data);
    }

    case "plex_get_recently_added": {
      const data = await plexGet("/library/recentlyAdded",
        { "X-Plex-Container-Size": args.limit || 20 });
      return ok(data?.MediaContainer?.Metadata || data);
    }

    case "plex_search": {
      const data = await plexGet("/search", { query: args.query });
      return ok(data?.MediaContainer?.Metadata || data);
    }

    case "plex_get_server_info": {
      const data = await plexGet("/");
      return ok(data?.MediaContainer || data);
    }

    case "plex_refresh_library":
      await plexGet(`/library/sections/${args.section_key}/refresh`);
      return txt("Library refresh triggered.");

    // Tautulli
    case "tautulli_get_activity":
      return ok(await tautulliGet("get_activity"));

    case "tautulli_get_history":
      return ok(await tautulliGet("get_history", {
        length: args.length || 25,
        ...(args.user && { user: args.user }),
        ...(args.media_type && { media_type: args.media_type }),
      }));

    case "tautulli_get_home_stats":
      return ok(await tautulliGet("get_home_stats", {
        time_range: args.time_range || 30,
        stats_count: args.stats_count || 5,
      }));

    case "tautulli_get_libraries":
      return ok(await tautulliGet("get_libraries"));

    case "tautulli_get_users":
      return ok(await tautulliGet("get_users"));

    case "tautulli_get_plays_by_date":
      return ok(await tautulliGet("get_plays_by_date", {
        time_range: args.time_range || 30,
        y_axis: args.y_axis || "plays",
      }));

    // TrueNAS SCALE
    case "truenas_get_pools":
      return ok(await tnGet("/pool"));

    case "truenas_get_datasets": {
      const ds = await tnGet("/pool/dataset", { limit: 100 });
      if (args.pool) {
        return ok(ds.filter(d => d.name.startsWith(args.pool)));
      }
      return ok(ds.map(d => ({
        name: d.name,
        type: d.type,
        used: d.used?.parsed,
        available: d.available?.parsed,
        mountpoint: d.mountpoint,
        compression: d.compression?.value,
      })));
    }

    case "truenas_get_disks":
      return ok(await tnGet("/disk", { extra: JSON.stringify({ include_expired: false }) }));

    case "truenas_get_alerts":
      return ok(await tnGet("/alert/list"));

    case "truenas_get_system_info":
      return ok(await tnGet("/system/info"));

    case "truenas_get_services":
      return ok(await tnGet("/service"));

    case "truenas_start_service":
      return ok(await tnPost("/service/start", { service: args.service }));

    case "truenas_stop_service":
      return ok(await tnPost("/service/stop", { service: args.service }));

    case "truenas_get_snapshots": {
      const params = { limit: args.limit || 20 };
      if (args.dataset) params.dataset = args.dataset;
      return ok(await tnGet("/zfs/snapshot", params));
    }

    case "truenas_get_replication_tasks":
      return ok(await tnGet("/replication"));

    case "truenas_get_scrub_tasks":
      return ok(await tnGet("/pool/scrub"));

    case "truenas_run_scrub":
      return ok(await tnPost("/pool/scrub", { name: args.pool, threshold: 0 }));

    case "truenas_get_smart_results":
      return ok(await tnGet("/smart/test/results"));

    case "truenas_get_network_interfaces":
      return ok(await tnGet("/interface"));

    case "truenas_get_update_status":
      return ok(await tnGet("/update/check_available"));

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}

// ── Server setup ──────────────────────────────────────────────────────────────
async function createServer() {
  const server = new Server(
    { name: "media-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      return await handleTool(req.params.name, req.params.arguments || {});
    } catch (e) {
      return err(e);
    }
  });

  return server;
}

async function main() {
  if (cfg.mode === "stdio") {
    // Original Claude Desktop mode
    const server = await createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[media-mcp] Running in stdio mode");
  } else {
    // HTTP mode using Express MCP app for proper header negotiation
    const app = createMcpExpressApp();

    // Health check endpoint
    app.get("/health", (req, res) => {
      res.json({ status: "ok", tools: TOOLS.length });
    });

    // Optional bearer-token auth. The server can control the whole media stack and
    // TrueNAS, so set MCP_AUTH_TOKEN and keep the port off the public internet.
    const requireAuth = (req, res, next) => {
      if (!cfg.authToken) return next();
      if (req.headers.authorization === `Bearer ${cfg.authToken}`) return next();
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
    };
    if (!cfg.authToken) {
      console.error("[media-mcp] WARNING: MCP_AUTH_TOKEN is not set, /mcp is unauthenticated");
    }

    // MCP endpoint — fresh server per request (stateless)
    app.post("/mcp", requireAuth, async (req, res) => {
      try {
        const reqServer = await createServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,  // stateless mode
        });
        await reqServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
        res.on("close", () => {
          transport.close();
          reqServer.close();
        });
      } catch (e) {
        console.error("[media-mcp] Request error:", e.message);
        if (!res.headersSent) {
          res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: e.message }, id: null });
        }
      }
    });

    app.listen(cfg.port, "0.0.0.0", () => {
      console.error(`[media-mcp] HTTP MCP server running on port ${cfg.port}`);
      console.error(`[media-mcp] ${TOOLS.length} tools available`);
    });
  }
}


main().catch(e => { console.error(e); process.exit(1); });
