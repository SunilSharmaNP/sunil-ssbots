/**
 * YouTube All-Quality Downloader — Vercel Serverless API
 * Upgraded with y2mate.yt Proof-of-Work (PoW) Token & Savenow.to Multi-Server Engine
 * ---------------------------------------------------------------------------------
 * Usage:
 *   GET  /api/youtube?url=https://youtu.be/VIDEO_ID&format=720
 *   POST /api/youtube   body: { "url": "https://youtu.be/VIDEO_ID", "format": "720" }
 *
 * Supported formats:
 *   Video: 1080, 720, 480, 360, 240, 144, 1440, 4k
 *   Audio: mp3, m4a, aac, flac, opus, ogg, wav
 *
 * Response: Direct download links from savenow.to subdomains (e.g. pamela88, emma18, dave15, etc.)
 */

const crypto = require("crypto");

// ─── YouTube URL Parsing ──────────────────────────────────────────────────────

const YOUTUBE_HOSTS = new Set([
  "www.youtube.com",
  "youtube.com",
  "m.youtube.com",
  "youtu.be",
  "music.youtube.com",
]);

function getVideoId(input) {
  if (typeof input !== "string" || input.trim().length === 0) return null;

  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(url.protocol)) return null;

  const hostname = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(hostname)) return null;

  if (hostname === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0];
    return id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null;
  }

  const queryId = url.searchParams.get("v");
  if (queryId && /^[A-Za-z0-9_-]{6,20}$/.test(queryId)) return queryId;

  const pathParts = url.pathname.split("/").filter(Boolean);
  const pathId =
    pathParts[0] === "shorts" || pathParts[0] === "embed" ? pathParts[1] : null;

  return pathId && /^[A-Za-z0-9_-]{6,20}$/.test(pathId) ? pathId : null;
}

function getRequestedUrl(req) {
  if (req.method === "GET") return req.query?.url;
  if (req.method === "POST") {
    if (typeof req.body === "string") {
      try { return JSON.parse(req.body)?.url; } catch { return null; }
    }
    return req.body?.url;
  }
  return null;
}

function getRequestedFormat(req) {
  if (req.method === "GET") return req.query?.format || req.query?.quality;
  if (req.method === "POST") {
    if (typeof req.body === "string") {
      try {
        const parsed = JSON.parse(req.body);
        return parsed?.format || parsed?.quality;
      } catch {
        return null;
      }
    }
    return req.body?.format || req.body?.quality;
  }
  return null;
}

function sendJson(res, status, data) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return res.status(status).json(data);
}

// ─── Savenow.to API Configuration & Headers ───────────────────────────────────

const SAVENOW_API_KEY  = "dfcb6d76f2f6a9894gjkege8a4ab232222";
const SAVENOW_BASE     = "https://p.savenow.to";
const POLL_INTERVAL_MS = 1500;          // poll every 1.5s
const POLL_MAX_TRIES   = 20;            // max ~30s per format
const REQUEST_TIMEOUT  = 12000;         // 12s per HTTP call

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  "Referer":    "https://y2mate.yt/",
  "Origin":     "https://y2mate.yt",
  "Accept":     "application/json, text/plain, */*",
};

/** Formats registry */
const FORMAT_MAP = {
  "1080": { id: "1080", label: "MP4 1080p FHD", type: "video" },
  "720":  { id: "720",  label: "MP4 720p HD",   type: "video" },
  "480":  { id: "480",  label: "MP4 480p SD",   type: "video" },
  "360":  { id: "360",  label: "MP4 360p Low",  type: "video" },
  "240":  { id: "240",  label: "MP4 240p Low",  type: "video" },
  "144":  { id: "144",  label: "MP4 144p Low",  type: "video" },
  "1440": { id: "1440", label: "MP4 1440p 2K",  type: "video" },
  "4k":   { id: "4k",   label: "WEBM 4K UHD",   type: "video" },
  "2160": { id: "4k",   label: "WEBM 4K UHD",   type: "video" },
  "mp3":  { id: "mp3",  label: "MP3 Audio (320kbps)", type: "audio" },
  "m4a":  { id: "m4a",  label: "M4A Audio",     type: "audio" },
  "aac":  { id: "aac",  label: "AAC Audio",     type: "audio" },
  "flac": { id: "flac", label: "FLAC Audio",    type: "audio" },
  "opus": { id: "opus", label: "OPUS Audio",    type: "audio" },
  "ogg":  { id: "ogg",  label: "OGG Audio",     type: "audio" },
  "wav":  { id: "wav",  label: "WAV Audio",     type: "audio" },
};

/** Default balanced formats when none specified */
const DEFAULT_FORMATS = [
  FORMAT_MAP["1080"],
  FORMAT_MAP["720"],
  FORMAT_MAP["480"],
  FORMAT_MAP["360"],
  FORMAT_MAP["mp3"],
  FORMAT_MAP["m4a"],
];

const ALL_FORMAT_LIST = [
  FORMAT_MAP["1080"],
  FORMAT_MAP["720"],
  FORMAT_MAP["480"],
  FORMAT_MAP["360"],
  FORMAT_MAP["240"],
  FORMAT_MAP["144"],
  FORMAT_MAP["1440"],
  FORMAT_MAP["4k"],
  FORMAT_MAP["mp3"],
  FORMAT_MAP["m4a"],
  FORMAT_MAP["aac"],
  FORMAT_MAP["flac"],
  FORMAT_MAP["opus"],
  FORMAT_MAP["ogg"],
  FORMAT_MAP["wav"],
];

// ─── PoW Token Solver & Cache ─────────────────────────────────────────────────

let cachedToken = null;
let tokenExpiresAt = 0;
let tokenInFlight = null;

async function fetchJSON(url, timeoutMs = REQUEST_TIMEOUT, token = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { ...HEADERS };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves y2mate.yt PoW challenge and obtains Authorization token.
 * Token is cached in-memory and re-used until near expiration.
 */
async function getValidToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && tokenExpiresAt - 30 > now) {
    return cachedToken;
  }

  if (tokenInFlight) {
    return tokenInFlight;
  }

  tokenInFlight = (async () => {
    try {
      // 1. Get PoW challenge
      const challengeRes = await fetchJSON(`${SAVENOW_BASE}/api/pow/challenge`, 6000);
      if (!challengeRes || !challengeRes.salt) {
        throw new Error("Invalid challenge response");
      }

      // 2. Solve PoW
      const difficulty = Number(challengeRes.difficulty) || 3;
      const prefix = "0".repeat(difficulty);
      let nonce = 0;
      const startTime = Date.now();
      let solvedNonce = null;

      while (Date.now() - startTime < 3500) {
        const hash = crypto
          .createHash("sha256")
          .update(String(challengeRes.salt) + ":" + String(nonce))
          .digest("hex");
        if (hash.startsWith(prefix)) {
          solvedNonce = nonce;
          break;
        }
        nonce++;
      }

      if (solvedNonce === null) {
        throw new Error("PoW solution budget exceeded");
      }

      // 3. Verify challenge
      const verifyRes = await fetch(`${SAVENOW_BASE}/api/pow/verify`, {
        method: "POST",
        headers: {
          ...HEADERS,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          salt: challengeRes.salt,
          difficulty: challengeRes.difficulty,
          expires_at: challengeRes.expires_at,
          signature: challengeRes.signature,
          nonce: solvedNonce,
        }),
      });

      const body = await verifyRes.json();
      if (!body.success || !body.token) {
        throw new Error("PoW verification failed");
      }

      cachedToken = body.token;
      tokenExpiresAt = Number(body.expires_at) || now + 300;
      return cachedToken;
    } catch (err) {
      console.warn("PoW token warning:", err.message);
      return null;
    } finally {
      tokenInFlight = null;
    }
  })();

  return tokenInFlight;
}

// ─── Step 1: Start a download job ─────────────────────────────────────────────

async function startDownload(ytUrl, formatId, token) {
  const apiUrl =
    `${SAVENOW_BASE}/api/v2/download` +
    `?format=${encodeURIComponent(formatId)}` +
    `&url=${encodeURIComponent(ytUrl)}` +
    `&apikey=${SAVENOW_API_KEY}`;

  const data = await fetchJSON(apiUrl, REQUEST_TIMEOUT, token);

  // If already returned direct download link
  if (data.download_url || data.url) {
    return {
      id: data.id || "ready",
      downloadUrl: data.download_url || data.url,
      title: data.title || data.info?.title,
      thumbnailUrl: data.thumbnail_url || data.info?.image,
      fullFormat: data.full_format || formatId,
    };
  }

  if (!data.id && !data.progress_url) {
    throw new Error(data.message || "Failed to initialize download job");
  }

  return data;
}

// ─── Step 2: Poll progress until finished ────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollUntilDone(progressUrl, token) {
  for (let attempt = 0; attempt < POLL_MAX_TRIES; attempt++) {
    await sleep(POLL_INTERVAL_MS);
    let data;
    try {
      data = await fetchJSON(progressUrl, 8000, token);
    } catch {
      continue; // retry on minor network blip
    }

    const downloadUrl = data.download_url || data.url;

    // Check if ready
    if (downloadUrl && downloadUrl.length > 5) {
      return { ok: true, downloadUrl, data };
    }

    const status = (data.text || "").toLowerCase();
    if (status === "error" || status === "failed") {
      return { ok: false, reason: data.message || "Conversion failed on server" };
    }
  }

  return { ok: false, reason: "Timed out waiting for file generation" };
}

// ─── Step 3: Process one format end-to-end ───────────────────────────────────

async function processFormat(ytUrl, fmt, token) {
  try {
    const job = await startDownload(ytUrl, fmt.id, token);

    // If already has direct link
    if (job.downloadUrl) {
      return {
        format:      fmt.id,
        label:       fmt.label,
        type:        fmt.type,
        status:      "ready",
        downloadUrl: job.downloadUrl,
        fullFormat:  job.fullFormat || fmt.label,
      };
    }

    const result = await pollUntilDone(job.progress_url, token);

    if (!result.ok) {
      return {
        format: fmt.id,
        label: fmt.label,
        type: fmt.type,
        status: "unavailable",
        reason: result.reason,
      };
    }

    return {
      format:      fmt.id,
      label:       fmt.label,
      type:        fmt.type,
      status:      "ready",
      downloadUrl: result.downloadUrl,
      fullFormat:  job.full_format || result.data?.format || fmt.label,
      size:        result.data?.size,
    };
  } catch (err) {
    return {
      format: fmt.id,
      label: fmt.label,
      type: fmt.type,
      status: "error",
      reason: err.message,
    };
  }
}

// ─── YouTube oEmbed metadata ─────────────────────────────────────────────────

async function getYouTubeMetadata(videoId) {
  const oembedUrl =
    `https://www.youtube.com/oembed` +
    `?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}` +
    `&format=json`;
  try {
    const meta = await fetchJSON(oembedUrl, 6000);
    return {
      title:        meta.title        || "Untitled YouTube Video",
      authorName:   meta.author_name  || "YouTube Creator",
      authorUrl:    meta.author_url   || "https://www.youtube.com/",
      thumbnailUrl: meta.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    };
  } catch {
    return {
      title:        "YouTube Video",
      authorName:   "YouTube",
      authorUrl:    "https://www.youtube.com/",
      thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    };
  }
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }

  if (!["GET", "POST"].includes(req.method)) {
    return sendJson(res, 405, { success: false, error: "Method not allowed. Use GET or POST." });
  }

  // 1. Validate YouTube URL
  const requestedUrl = getRequestedUrl(req);
  const videoId      = getVideoId(requestedUrl);

  if (!videoId) {
    return sendJson(res, 400, {
      success: false,
      error: "A valid YouTube URL is required.",
      examples: [
        "?url=https://youtu.be/dQw4w9WgXcQ",
        "?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "?url=https://www.youtube.com/shorts/VIDEO_ID",
      ],
    });
  }

  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const requestedFmtId = getRequestedFormat(req);
  const wantAll = req.query?.all === "true" || req.body?.all === true;

  // 2. Select target formats to convert
  let targetFormats;
  if (requestedFmtId && FORMAT_MAP[requestedFmtId.toLowerCase()]) {
    targetFormats = [FORMAT_MAP[requestedFmtId.toLowerCase()]];
  } else if (wantAll) {
    targetFormats = ALL_FORMAT_LIST;
  } else {
    targetFormats = DEFAULT_FORMATS;
  }

  try {
    // 3. Acquire valid y2mate / savenow PoW token
    const token = await getValidToken();

    // 4. Fetch metadata + formats in parallel
    const [meta, ...formatResults] = await Promise.all([
      getYouTubeMetadata(videoId),
      ...targetFormats.map((fmt) => processFormat(ytUrl, fmt, token)),
    ]);

    const available   = formatResults.filter((r) => r.status === "ready");
    const unavailable = formatResults.filter((r) => r.status !== "ready");

    // Preferred primary download link (720p > 1080p > first available)
    const primary =
      available.find((r) => r.format === "720") ||
      available.find((r) => r.format === "1080") ||
      available[0] ||
      null;

    // Stream link
    const streamCandidate = available.find((r) => r.type === "video");

    return sendJson(res, 200, {
      success:       available.length > 0,
      videoId,
      sourceUrl:     requestedUrl,
      watchUrl:      ytUrl,
      embedUrl:      `https://www.youtube.com/embed/${videoId}`,
      title:         meta.title,
      authorName:    meta.authorName,
      authorUrl:     meta.authorUrl,
      thumbnailUrl:  meta.thumbnailUrl,

      // Top direct download link (ready for 1-click or bot download)
      downloadUrl:   primary ? primary.downloadUrl : null,
      streamUrl:     streamCandidate ? streamCandidate.downloadUrl : null,

      // All ready direct download links
      downloadLinks: available.map((r) => ({
        format:      r.format,
        label:       r.label,
        type:        r.type,
        fullFormat:  r.fullFormat,
        downloadUrl: r.downloadUrl,
        url:         r.downloadUrl,
      })),

      // Alias formats array for bot compatibility
      formats: available.map((r) => ({
        format:      r.format,
        quality:     r.label,
        type:        r.type,
        url:         r.downloadUrl,
        downloadUrl: r.downloadUrl,
      })),

      // Summary counts
      summary: {
        total:       targetFormats.length,
        available:   available.length,
        unavailable: unavailable.length,
      },

      // Failed / unavailable formats
      unavailableFormats: unavailable.map((r) => ({
        format: r.format,
        label:  r.label,
        reason: r.reason,
      })),
    });
  } catch (err) {
    return sendJson(res, 500, {
      success: false,
      error: err.message || "Failed to extract YouTube download links",
    });
  }
};
