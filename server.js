const { addonBuilder, serveHTTP } = require('stremio-addon-sdk')
const { createClient } = require('@supabase/supabase-js')
const axios = require('axios')

// ========================
// Supabase (Railway ready)
// ========================

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('❌ Faltan variables de entorno SUPABASE_URL o SUPABASE_ANON_KEY')
    process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
        // No necesitamos sesiones en un addon de Stremio
        persistSession: false
    }
})

// ========================
// OMDB helper
// ========================

const OMDB_API_KEY = process.env.OMDB_API_KEY
if (!OMDB_API_KEY) {
    console.warn('⚠️ OMDB_API_KEY no configurado. No se podrá autocompletar títulos desde OMDb.')
}

async function upsertTitleFromOmdb(imdbId, typeHint) {
    if (!OMDB_API_KEY) {
        return null
    }

    try {

        let url = `http://www.omdbapi.com/?apikey=${OMDB_API_KEY}&i=${encodeURIComponent(imdbId)}`;
        let res = await axios.get(url);

        const data = res.data
        if (!data || data.Response === 'False') {
            console.warn('⚠️ OMDb no encontró datos para', imdbId, data && data.Error)
            return null
        }

        console.log('✅ Título encontrado en OMDb:', data)

        // Mapear tipo a nuestro enum (movie/series)
        const omdbType = (data.Type || '').toLowerCase()
        const type =
            omdbType === 'series'
                ? 'series'
                : omdbType === 'movie'
                    ? 'movie'
                    : typeHint // fallback: lo que Stremio dijo

        const payload = {
            type,
            imdb_id: imdbId,
            name: data.Title || imdbId,
            original_name: data.Title,
            year: data.Year ? parseInt(String(data.Year).slice(0, 4), 10) : null,
            poster_url: data.Poster && data.Poster !== 'N/A' ? data.Poster : null,
            overview: data.Plot && data.Plot !== 'N/A' ? data.Plot : null,
            is_enabled: true
        }

        const { data: insertData, error } = await supabase
            .from('cxv_title')
            .insert(payload)
            .select('id, type, is_enabled')
            .single()

        if (error) {
            console.error('❌ Error insertando cxv_title desde OMDb:', error)
            return null
        }

        console.log('✅ Título creado en cxv_title desde OMDb:', {
            imdbId,
            id: insertData.id,
            type: insertData.type
        })

        return insertData
    } catch (err) {
        console.error('💥 Error consultando OMDb para', imdbId, err)
        return null
    }
}

// ========================
// Real-Debrid helper
// ========================

async function resolveRealDebrid(originalUrl, options = {}) {
    const token = process.env.REALDEBRID_API_TOKEN
    const remote = options.remote ?? 0       // 0 o 1
    const password = options.password ?? ""  // si algún link requiere password hoster-side

    if (!token) {
        console.warn("⚠️ REALDEBRID_API_TOKEN no configurado. Se usa el URL original.")
        return originalUrl
    }

    try {
        const body = new URLSearchParams()
        body.append("link", originalUrl)
        if (password) body.append("password", password)
        body.append("remote", String(remote))

        const res = await fetch("https://api.real-debrid.com/rest/1.0/unrestrict/link", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body
        })

        // Manejo de errores HTTP
        if (!res.ok) {
            const text = await res.text().catch(() => "")
            console.error(`❌ RD HTTP ${res.status} ${res.statusText} para ${originalUrl}:`, text)
            // 4xx / 5xx -> regresamos URL original para no romper el stream
            return originalUrl
        }

        const data = await res.json()

        // Caso general: data.download es el link generado
        // (aunque haya alternativas de calidad, siempre viene un "download" principal)
        if (data && typeof data.download === "string") {
            console.log("RD ▶️ Link premium generado:", data.download)

            // Si quisieras elegir calidad de "alternative", aquí podrías inspeccionar data.alternative
            // p.ej. escoger el que tenga type = '1080p' o similar.

            return data.download
        }

        console.warn("⚠️ RD no devolvió 'download', usando URL original:", originalUrl)
        return originalUrl

    } catch (err) {
        console.error("💥 Error Real-Debrid:", err)
        return originalUrl
    }
}


// ========================
// Config del addon cxv
// ========================

const builder = new addonBuilder({
    id: 'org.cxv.addon',
    version: '1.0.0',
    name: 'cxv',
    catalogs: [],           // solo streams, sin catálogos
    resources: ['stream'],
    types: ['movie', 'series'],
    catalogs: [
        {
            type: 'movie',
            id: 'cxv-movies',
            name: 'CXV Movies',
            extra: [
                { name: 'search', isRequired: false } // permite búsqueda
            ]
        },
        {
            type: 'series',
            id: 'cxv-series',
            name: 'CXV Series',
            extra: [
                { name: 'search', isRequired: false }
            ]
        }
    ],
    idPrefixes: ['tt']      // trabajamos con IDs IMDb
})

// ========================
// Handler de streams (Supabase)
// ========================

builder.defineStreamHandler(async function (args) {
    console.log('📥 Stream request:', args)



    try {
        // -------------------------
        // 1) Parsear ID de Stremio
        // -------------------------
        let imdbId = args.id
        let season = null
        let episode = null

        if (args.type === 'series') {
            const parts = args.id.split(':')
            imdbId = parts[0]
            season = parseInt(parts[1], 10)
            episode = parseInt(parts[2], 10)
        }

        // -------------------------
        // 2) Buscar título en cxv_title
        // -------------------------
        const { data: titleRow, error: titleError } = await supabase
            .from('cxv_title')
            .select('id, type, is_enabled')
            .eq('imdb_id', imdbId)
            .eq('is_enabled', true)
            .maybeSingle()

        if (titleError) {
            console.error('❌ Error consultando cxv_title:', titleError)
            return { streams: [] }
        }

        // 🔹 ahora usamos una variable mutable "title"
        let title = titleRow

        if (!title) {
            console.log('ℹ️ No se encontró título en cxv_title para imdb_id:', imdbId)
            console.log('ℹ️ Intentando crear título desde OMDb...')
            title = await upsertTitleFromOmdb(imdbId, args.type)

            if (!title) {
                // Si tampoco se pudo crear desde OMDb, no hay nada más que hacer
                return { streams: [] }
            }
        }

        // -------------------------
        // 3) Buscar streams en cxv_stream
        // -------------------------
        let query = supabase
            .from('cxv_stream')
            .select('url, label, priority, is_enabled')
            .eq('title_id', title.id)
            .eq('is_enabled', true)
            .order('priority', { ascending: true })

        if (args.type === 'movie') {
            // Películas: season/episode = NULL
            query = query
                .is('season', null)
                .is('episode', null)
        } else if (args.type === 'series') {
            // Series: filtrar por temporada y episodio
            if (!Number.isInteger(season) || !Number.isInteger(episode)) {
                console.warn('⚠️ Petición de serie sin season/episode válidos:', args.id)
                return { streams: [] }
            }
            query = query
                .eq('season', season)
                .eq('episode', episode)
        }

        const { data: streamsData, error: streamsError } = await query

        if (streamsError) {
            console.error('❌ Error consultando cxv_stream:', streamsError)
            return { streams: [] }
        }

        if (!streamsData || streamsData.length === 0) {
            console.log('ℹ️ No hay streams configurados en cxv_stream para', {
                imdbId,
                type: args.type,
                season,
                episode
            })
            return { streams: [] }
        }

        // -------------------------
        // 4) Mapear a formato Stremio
        // -------------------------
        const streams = []

        for (const row of streamsData) {
            const premiumUrl = await resolveRealDebrid(row.url)

            streams.push({
                url: premiumUrl,
                title: row.label || undefined
            })
        }

        console.log(`✅ Devolviendo ${streams.length} stream(s) para`, {
            imdbId,
            type: args.type,
            season,
            episode,
            premium: streams.map(s => s.url)
        })

        return { streams }
    } catch (err) {
        console.error('💥 Error inesperado en stream handler:', err)
        return { streams: [] }
    }
})


// ========================
// Handler de catálogos: solo títulos con streams
// ========================

builder.defineCatalogHandler(async ({ type, id, extra }) => {
    console.log('📥 Catalog request:', { type, id, extra })

    const validCatalogs = ['cxv-movies', 'cxv-series']
    if (!validCatalogs.includes(id)) {
        return { metas: [] }
    }

    const search = extra?.search ? String(extra.search).trim() : null

    try {
        // 1. Consultar títulos habilitados del tipo solicitado
        let titleQuery = supabase
            .from('cxv_title')
            .select('id, imdb_id, type, name, original_name, year, poster_url, overview, is_enabled')
            .eq('type', type)
            .eq('is_enabled', true)

        if (search) {
            titleQuery = titleQuery.ilike('name', `%${search}%`)
        }

        // Traemos hasta 200 títulos (ajustable)
        const { data: titles, error: titleErr } = await titleQuery.limit(200)

        if (titleErr) {
            console.error('❌ Error consultando cxv_title:', titleErr)
            return { metas: [] }
        }

        if (!titles || titles.length === 0) {
            return { metas: [] }
        }

        // 2. Obtener IDs de títulos que tengan streams habilitados
        const titleIds = titles.map(t => t.id)

        const { data: streams, error: streamErr } = await supabase
            .from('cxv_stream')
            .select('title_id')
            .in('title_id', titleIds)
            .eq('is_enabled', true)

        if (streamErr) {
            console.error('❌ Error consultando cxv_stream:', streamErr)
            return { metas: [] }
        }

        if (!streams || streams.length === 0) {
            return { metas: [] }
        }

        // IDs que SÍ tienen streams
        const activeTitleIds = new Set(streams.map(s => s.title_id))

        // 3. Filtrar títulos que tengan streams asociados
        const filteredTitles = titles.filter(t => activeTitleIds.has(t.id))

        // 4. Convertir a metas de Stremio
        const metas = filteredTitles.map(row => ({
            id: row.imdb_id,
            type: row.type,
            name: row.name || row.original_name || row.imdb_id,
            poster: row.poster_url || undefined,
            description: row.overview || undefined,
            year: row.year || undefined
        }))

        console.log(`📦 Catálogo ${id}: ${metas.length} título(s) con streams`)
        return { metas }
    } catch (err) {
        console.error('💥 Error inesperado en catalog handler:', err)
        return { metas: [] }
    }
})


// ========================
// Levantar el servidor HTTP
// ========================

const PORT = process.env.PORT || 7000
serveHTTP(builder.getInterface(), { port: PORT })


