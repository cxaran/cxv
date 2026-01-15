import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import { createHandler } from "stremio-rewired";

// ========================
// Supabase
// ========================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("❌ Faltan SUPABASE_URL o SUPABASE_ANON_KEY");
}

const supabase =
  SUPABASE_URL && SUPABASE_ANON_KEY
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false },
      })
    : null;

// ========================
// OMDb helper
// ========================
const OMDB_API_KEY = process.env.OMDB_API_KEY;

async function upsertTitleFromOmdb(imdbId, typeHint) {
  if (!OMDB_API_KEY || !supabase) return null;

  try {
    const url = `https://www.omdbapi.com/?apikey=${OMDB_API_KEY}&i=${encodeURIComponent(
      imdbId
    )}`;
    const res = await axios.get(url);
    const data = res.data;

    if (!data || data.Response === "False") return null;

    const omdbType = String(data.Type || "").toLowerCase();
    const type =
      omdbType === "series" ? "series" : omdbType === "movie" ? "movie" : typeHint;

    const payload = {
      type,
      imdb_id: imdbId,
      name: data.Title || imdbId,
      original_name: data.Title || null,
      year: data.Year ? parseInt(String(data.Year).slice(0, 4), 10) : null,
      poster_url: data.Poster && data.Poster !== "N/A" ? data.Poster : null,
      overview: data.Plot && data.Plot !== "N/A" ? data.Plot : null,
      is_enabled: true,
    };

    const { data: insertData, error } = await supabase
      .from("cxv_title")
      .insert(payload)
      .select("id, type, is_enabled")
      .single();

    if (error) return null;
    return insertData;
  } catch {
    return null;
  }
}

// ========================
// Real-Debrid helper
// ========================
async function resolveRealDebrid(originalUrl, options = {}) {
  const token = process.env.REALDEBRID_API_TOKEN;
  const remote = options.remote ?? 0;
  const password = options.password ?? "";

  if (!token) return originalUrl;

  try {
    const body = new URLSearchParams();
    body.append("link", originalUrl);
    if (password) body.append("password", password);
    body.append("remote", String(remote));

    const res = await fetch("https://api.real-debrid.com/rest/1.0/unrestrict/link", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    if (!res.ok) return originalUrl;

    const data = await res.json();
    if (data && typeof data.download === "string") return data.download;

    return originalUrl;
  } catch {
    return originalUrl;
  }
}

// ========================
// Stremio manifest (debe estar en /manifest.json)
// ========================
const manifest = {
  id: "org.cxv.addon",
  version: "1.0.0",
  name: "cxv",
  description: "CXV Streams from Supabase",
  resources: ["stream", "catalog"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [
    {
      type: "movie",
      id: "cxv-movies",
      name: "CXV Movies",
      extra: [{ name: "search", isRequired: false }],
    },
    {
      type: "series",
      id: "cxv-series",
      name: "CXV Series",
      extra: [{ name: "search", isRequired: false }],
    },
  ],
};

// ========================
// Create serverless handler (fetch-based)
// ========================
const handle = createHandler({
  manifest,

  async onStreamRequest(type, id) {
    if (!supabase) return { streams: [] };

    try {
      let imdbId = id;
      let season = null;
      let episode = null;

      if (type === "series") {
        const parts = String(id).split(":");
        imdbId = parts[0];
        season = parseInt(parts[1], 10);
        episode = parseInt(parts[2], 10);
        if (!Number.isInteger(season) || !Number.isInteger(episode)) return { streams: [] };
      }

      const { data: titleRow } = await supabase
        .from("cxv_title")
        .select("id, type, is_enabled")
        .eq("imdb_id", imdbId)
        .eq("is_enabled", true)
        .maybeSingle();

      let title = titleRow;

      if (!title) {
        title = await upsertTitleFromOmdb(imdbId, type);
        if (!title) return { streams: [] };
      }

      let query = supabase
        .from("cxv_stream")
        .select("url, label, priority, is_enabled, season, episode")
        .eq("title_id", title.id)
        .eq("is_enabled", true)
        .order("priority", { ascending: true });

      if (type === "movie") {
        query = query.is("season", null).is("episode", null);
      } else {
        query = query.eq("season", season).eq("episode", episode);
      }

      const { data: streamsData } = await query;
      if (!streamsData?.length) return { streams: [] };

      const streams = [];
      for (const row of streamsData) {
        const premiumUrl = await resolveRealDebrid(row.url);
        streams.push({ url: premiumUrl, title: row.label || undefined });
      }

      return { streams };
    } catch {
      return { streams: [] };
    }
  },

  async onCatalogRequest(type, id, extra) {
    if (!supabase) return { metas: [] };

    const validCatalogs = new Set(["cxv-movies", "cxv-series"]);
    if (!validCatalogs.has(id)) return { metas: [] };

    const search = extra?.search ? String(extra.search).trim() : null;

    try {
      let titleQuery = supabase
        .from("cxv_title")
        .select("id, imdb_id, type, name, original_name, year, poster_url, overview, is_enabled")
        .eq("type", type)
        .eq("is_enabled", true);

      if (search) titleQuery = titleQuery.ilike("name", `%${search}%`);

      const { data: titles } = await titleQuery.limit(200);
      if (!titles?.length) return { metas: [] };

      const titleIds = titles.map((t) => t.id);

      const { data: streams } = await supabase
        .from("cxv_stream")
        .select("title_id")
        .in("title_id", titleIds)
        .eq("is_enabled", true);

      if (!streams?.length) return { metas: [] };

      const activeTitleIds = new Set(streams.map((s) => s.title_id));
      const filtered = titles.filter((t) => activeTitleIds.has(t.id));

      const metas = filtered.map((row) => ({
        id: row.imdb_id,
        type: row.type,
        name: row.name || row.original_name || row.imdb_id,
        poster: row.poster_url || undefined,
        description: row.overview || undefined,
        year: row.year || undefined,
      }));

      return { metas };
    } catch {
      return { metas: [] };
    }
  },
});

// ========================
// Vercel Node Function adapter (req,res -> Request -> Response)
// ========================
export default async function handler(req, res) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const url = new URL(req.url, `${proto}://${host}`);

  // Pasar querystring y ruta tal cual a fetch Request
  const request = new Request(url, {
    method: req.method,
    headers: req.headers,
  });

  const response = await handle(request);

  if (!response) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }

  // Copiar status + headers
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));

  const body = Buffer.from(await response.arrayBuffer());
  res.end(body);
}

