/**
 * YouTube All-Quality Downloader — Fixed & Optimized Savenow Engine
 * ------------------------------------------------------------------
 * Fixes the 15-format concurrent flood issue that was causing rate-limits,
 * timeouts, and ad-redirection on p.savenow.to.
 *
 * Usage:
 *   GET  /api/youtube?url=https://youtu.be/VIDEO_ID&quality=720
 *   POST /api/youtube   body: { "url": "https://youtu.be/VIDEO_ID", "quality": "1080" }
 */

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
      try {
        return JSON.parse(req.body)?.url;
      } catch {
        return null;
      }
    }
    return req.body?.url;
  }
  return null;
}

function getRequestedQuality(req) {
  const q = req.method === "GET" ? req.query?.quality : req.body?.quality;
  if (!q) return "720"; // default to fast 720p HD
  const s = String(q).toLowerCase().replace("video:", "").replace("audio:", "");
  if (s === "mp3" || s.includes("audio")) return "mp3";
  return s;
}

function sendJson(res, status, data) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return res.status(status).json(data);
}

// ─── Savenow.to API Configuration ────────────────────────────────────────────

const SAVENOW_API_KEY  = "dfcb6d76f2f6a9894gjkege8a4ab232222";
const SAVENOW_BASE     = "https://p.savenow.to";
const POLL_INTERVAL_MS = 1500;          // poll every 1.5s
const POLL_MAX_TRIES   = 20;            // max ~30s
const REQUEST_TIMEOUT  = 12000;

// In-memory cache to prevent duplicate conversions and serve instantly
const cache = new Map();

/** All supported formats */
const ALL_FORMATS = [
  { id: "1080", label: "MP4 1080p (Full HD)", type: "video" },
  { id: "720",  label: "MP4 720p (HD)",       type: "video" },
  { id: "480",  label: "MP4 480p (SD)",       type: "video" },
  { id: "360",  label: "MP4 360p (Fast)",     type: "video" },
  { id: "1440", label: "MP4 1440p (2K)",      type: "video" },
  { id: "4k",   label: "WEBM 4K (Ultra HD)",  type: "video" },
  { id: "mp3",  label: "MP3 Audio (High)",    type: "audio" },
  { id: "m4a",  label: "M4A Audio (AAC)",     type: "audio" },
  { id: "flac", label: "FLAC Audio (Lossless)", type: "audio" },
];

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  "Referer":    "https://y2mate.yt/",
  "Origin":     "https://y2mate.yt",
};

async function fetchJSON(url, timeoutMs = REQUEST_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Step 1: Start a download job for one format ───────────────────────────────

async function startDownload(ytUrl, format) {
  const apiUrl =
    `${SAVENOW_BASE}/api/v2/download` +
    `?format=${encodeURIComponent(format)}` +
    `&url=${encodeURIComponent(ytUrl)}` +
    `&apikey=${SAVENOW_API_KEY}`;

  const data = await fetchJSON(apiUrl);

  if (!data.success || !data.id || !data.progress_url) {
    throw new Error(data.message || "No job ID returned by converter");
  }
  return data;
}

// ─── Step 2: Poll progress until finished ────────────────────────────────────

async function pollUntilDone(progressUrl) {
  for (let attempt = 0; attempt < POLL_MAX_TRIES; attempt++) {
    await sleep(POLL_INTERVAL_MS);
    let data;
    try {
      data = await fetchJSON(progressUrl);
    } catch {
      continue;
    }

    const status = (data.text || "").toLowerCase();

    // Done with valid download URL
    if (data.success === 1 && data.download_url) {
      return { ok: true, downloadUrl: data.download_url, data };
    }

    // Explicit failure
    if (status === "error" || status === "failed") {
      return { ok: false, reason: data.message || "conversion error" };
    }
  }

  return { ok: false, reason: "timed out waiting for converter" };
}

// ─── Step 3: Process one format end-to-end ───────────────────────────────────

async function processFormat(ytUrl, formatId, label = "", type = "video") {
  const cacheKey = `${ytUrl}_${formatId}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  try {
    const job = await startDownload(ytUrl, formatId);
    const result = await pollUntilDone(job.progress_url);

    if (!result.ok) {
      return {
        format: formatId,
        label: label || `Format ${formatId}`,
        type,
        status: "unavailable",
        reason: result.reason,
      };
    }

    const payload = {
      format: formatId,
      label: label || job.full_format || `Format ${formatId}`,
      type,
      status: "ready",
      downloadUrl: result.downloadUrl,
      fullFormat: job.full_format || label,
    };

    cache.set(cacheKey, payload);
    return payload;
  } catch (err) {
    return {
      format: formatId,
      label: label || `Format ${formatId}`,
      type,
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
    const meta = await fetchJSON(oembedUrl, 8000);
    return {
      title: meta.title || "YouTube Video",
      authorName: meta.author_name || "Creator",
      authorUrl: meta.author_url || "https://www.youtube.com/",
      thumbnailUrl: meta.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    };
  } catch {
    return {
      title: "YouTube Video",
      authorName: "Creator",
      authorUrl: "https://www.youtube.com/",
      thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    };
  }
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return sendJson(res, 405, { error: "Use GET or POST." });
  }

  // ── Validate YouTube URL ────────────────────────────────────────────────────
  const requestedUrl = getRequestedUrl(req);
  const videoId = getVideoId(requestedUrl);

  if (!videoId) {
    return sendJson(res, 400, {
      success: false,
      error: "A valid YouTube URL is required in 'url' parameter.",
      examples: [
        "/api/youtube?url=https://youtu.be/bmMNlw6wAAY",
        "/api/youtube?url=https://www.youtube.com/watch?v=bmMNlw6wAAY&quality=1080",
        "/api/youtube?url=https://www.youtube.com/watch?v=bmMNlw6wAAY&quality=720",
        "/api/youtube?url=https://www.youtube.com/watch?v=bmMNlw6wAAY&quality=mp3",
      ],
    });
  }

  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const targetQuality = getRequestedQuality(req);
  const startTime = Date.now();

  try {
    // ── Fetch metadata first ──────────────────────────────────────────────────
    const meta = await getYouTubeMetadata(videoId);

    // ── Target primary format first (Fast, clean, no server overloading) ─────
    const primaryFormat = ALL_FORMATS.find((f) => f.id === targetQuality) || {
      id: targetQuality,
      label: `MP4 ${targetQuality}p`,
      type: targetQuality === "mp3" ? "audio" : "video",
    };

    // Process primary format
    const primaryResult = await processFormat(
      ytUrl,
      primaryFormat.id,
      primaryFormat.label,
      primaryFormat.type
    );

    // Construct download links list
    const downloadLinks = [];

    // If primary format succeeded, put it at the top
    if (primaryResult.status === "ready" && primaryResult.downloadUrl) {
      downloadLinks.push({
        format: primaryResult.format,
        label: `${primaryResult.label} (Primary Direct DDL)`,
        type: primaryResult.type,
        quality: `${primaryResult.format}${primaryResult.type === "audio" ? "kbps" : "p"}`,
        downloadUrl: primaryResult.downloadUrl,
        verified: true,
      });
    }

    // Add all other supported formats with on-demand resolution endpoint
    for (const fmt of ALL_FORMATS) {
      if (fmt.id === primaryResult.format && primaryResult.downloadUrl) {
        continue; // already added above
      }

      const cached = cache.get(`${ytUrl}_${fmt.id}`);
      downloadLinks.push({
        format: fmt.id,
        label: fmt.label,
        type: fmt.type,
        quality: `${fmt.id}${fmt.type === "audio" ? "kbps" : "p"}`,
        downloadUrl: cached?.downloadUrl || undefined,
        url: `/api/youtube?url=${encodeURIComponent(ytUrl)}&quality=${fmt.id}`,
        verified: !!cached?.downloadUrl,
      });
    }

    const availableLinks = downloadLinks.filter((l) => !!l.downloadUrl);

    // Build clean response
    return sendJson(res, 200, {
      success: true,
      service: "youtube",
      provider: "savenow-direct",
      videoId,
      title: meta.title,
      authorName: meta.authorName,
      authorUrl: meta.authorUrl,
      thumbnailUrl: meta.thumbnailUrl,
      sourceUrl: requestedUrl,
      watchUrl: ytUrl,
      embedUrl: `https://www.youtube.com/embed/${videoId}`,
      
      // ✅ Direct media file download link
      downloadUrl: primaryResult.downloadUrl || null,
      resolvedFormat: primaryResult.format,
      
      // ✅ All ready & on-demand download links
      downloadLinks,
      
      summary: {
        total: ALL_FORMATS.length,
        ready: availableLinks.length,
      },
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    console.error("YouTube extractor error:", err);
    return sendJson(res, 500, {
      success: false,
      service: "youtube",
      error: err.message || "Failed to process YouTube download link",
      durationMs: Date.now() - startTime,
    });
  }
};
