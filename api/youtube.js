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
const { Readable } = require("stream");

function getBaseUrl(req) {
  const host = req.headers?.host || (req.get && req.get("host")) || "localhost:3000";
  const proto = req.headers?.["x-forwarded-proto"] || req.protocol || "https";
  return `${proto}://${host}`;
}

async function streamMediaDirectly(downloadUrl, title, fmtInfo, res, retryYtUrl = null) {
  try {
    let targetUrl = downloadUrl;
    let upstreamRes = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://y2mate.yt/",
        "Origin": "https://y2mate.yt",
      },
      redirect: "follow",
    });

    let contentType = upstreamRes.headers.get("content-type") || "";

    // If upstream redirected to an ad HTML page or expired token, re-mint immediately
    if (contentType.includes("text/html") || upstreamRes.url.includes("ad/b.php") || upstreamRes.url.includes("ey43.com")) {
      if (retryYtUrl) {
        cachedToken = null;
        const freshToken = await getValidToken();
        const freshJob = await processFormat(retryYtUrl, fmtInfo, freshToken);
        if (freshJob && freshJob.status === "ready" && freshJob.downloadUrl) {
          targetUrl = freshJob.downloadUrl;
          upstreamRes = await fetch(targetUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
              "Referer": "https://y2mate.yt/",
              "Origin": "https://y2mate.yt",
            },
            redirect: "follow",
          });
          contentType = upstreamRes.headers.get("content-type") || "";
        }
      }
    }

    if (!upstreamRes.ok || contentType.includes("text/html")) {
      return sendJson(res, 502, {
        success: false,
        error: "Upstream media server returned an ad/expired token. Please retry the request to generate a fresh stream.",
      });
    }

    const finalContentType = contentType || (fmtInfo?.type === "audio" ? "audio/mpeg" : "video/mp4");
    const ext = fmtInfo?.type === "audio" ? (fmtInfo.id === "m4a" ? "m4a" : "mp3") : "mp4";
    const cleanTitle = (title || "video").replace(/[^\w\s\-\.\u0900-\u097F]/gi, "").trim() || "download";
    const filename = `${cleanTitle}.${ext}`;

    res.setHeader("Content-Type", finalContentType);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader("Access-Control-Allow-Origin", "*");

    const contentLength = upstreamRes.headers.get("content-length");
    if (contentLength) {
      res.setHeader("Content-Length", contentLength);
    }

    if (res.req && res.req.method === "HEAD") {
      return res.status(200).end();
    }

    const nodeStream = Readable.fromWeb(upstreamRes.body);
    nodeStream.on("error", () => {
      if (!res.writableEnded) res.end();
    });
    res.on("close", () => {
      nodeStream.destroy();
    });
    nodeStream.pipe(res);
  } catch (err) {
    if (!res.headersSent) {
      return sendJson(res, 500, {
        success: false,
        error: `Streaming failed: ${err.message}`,
      });
    }
  }
}

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
  "1080": { id: "1080", quality: "1080p", label: "MP4 1080p FHD (Video + Audio)", type: "video", hasAudio: true, hasVideo: true },
  "720":  { id: "720",  quality: "720p",  label: "MP4 720p HD (Video + Audio)",   type: "video", hasAudio: true, hasVideo: true },
  "480":  { id: "480",  quality: "480p",  label: "MP4 480p SD (Video + Audio)",   type: "video", hasAudio: true, hasVideo: true },
  "360":  { id: "360",  quality: "360p",  label: "MP4 360p Low (Video + Audio)",  type: "video", hasAudio: true, hasVideo: true },
  "240":  { id: "240",  quality: "240p",  label: "MP4 240p Low (Video + Audio)",  type: "video", hasAudio: true, hasVideo: true },
  "144":  { id: "144",  quality: "144p",  label: "MP4 144p Low (Video + Audio)",  type: "video", hasAudio: true, hasVideo: true },
  "1440": { id: "1440", quality: "1440p", label: "MP4 1440p 2K (Video + Audio)",  type: "video", hasAudio: true, hasVideo: true },
  "4k":   { id: "4k",   quality: "4k",    label: "WEBM 4K UHD (Video + Audio)",   type: "video", hasAudio: true, hasVideo: true },
  "2160": { id: "4k",   quality: "4k",    label: "WEBM 4K UHD (Video + Audio)",   type: "video", hasAudio: true, hasVideo: true },
  "mp3":  { id: "mp3",  quality: "320kbps", label: "MP3 Audio Only",             type: "audio", hasAudio: true, hasVideo: false },
  "m4a":  { id: "m4a",  quality: "128kbps", label: "M4A Audio Only",             type: "audio", hasAudio: true, hasVideo: false },
  "aac":  { id: "aac",  quality: "128kbps", label: "AAC Audio Only",             type: "audio", hasAudio: true, hasVideo: false },
  "flac": { id: "flac", quality: "Lossless", label: "FLAC Audio Only",           type: "audio", hasAudio: true, hasVideo: false },
  "opus": { id: "opus", quality: "160kbps", label: "OPUS Audio Only",           type: "audio", hasAudio: true, hasVideo: false },
  "ogg":  { id: "ogg",  quality: "192kbps", label: "OGG Audio Only",             type: "audio", hasAudio: true, hasVideo: false },
  "wav":  { id: "wav",  quality: "Lossless", label: "WAV Audio Only",            type: "audio", hasAudio: true, hasVideo: false },
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

const VIDEO_ONLY_FORMATS = [
  FORMAT_MAP["1080"],
  FORMAT_MAP["720"],
  FORMAT_MAP["480"],
  FORMAT_MAP["360"],
];

const AUDIO_ONLY_FORMATS = [
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

  if (!["GET", "POST", "HEAD"].includes(req.method)) {
    return sendJson(res, 405, { success: false, error: "Method not allowed. Use GET, POST, or HEAD." });
  }

  // 0. Support proxy streaming if requested
  if (req.query?.proxy) {
    const proxyUrl = req.query.proxy;
    const title = req.query.title || "video";
    const fmt = { id: req.query.format || "720", type: req.query.type || "video" };
    const retryYt = req.query.ytUrl ? decodeURIComponent(req.query.ytUrl) : null;
    return streamMediaDirectly(proxyUrl, title, fmt, res, retryYt);
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
  const isDirectDownload = req.query?.dl === "true" || req.query?.stream === "true" || req.query?.download === "true";
  const baseUrl = getBaseUrl(req);

  // If client wants direct media stream (no ads, zero redirection)
  if (isDirectDownload) {
    const targetFmt = FORMAT_MAP[requestedFmtId ? requestedFmtId.toLowerCase() : "720"] || FORMAT_MAP["720"];
    try {
      const token = await getValidToken();
      const [meta, job] = await Promise.all([
        getYouTubeMetadata(videoId),
        processFormat(ytUrl, targetFmt, token),
      ]);

      if (job && job.status === "ready" && job.downloadUrl) {
        return streamMediaDirectly(job.downloadUrl, meta.title, targetFmt, res, ytUrl);
      } else {
        return sendJson(res, 502, {
          success: false,
          error: job?.reason || "Failed to resolve stream for this format",
        });
      }
    } catch (err) {
      return sendJson(res, 500, {
        success: false,
        error: err.message || "Failed to stream media",
      });
    }
  }

  const typeFilter = (req.query?.type || req.query?.only || "").toLowerCase();
  const wantAll = req.query?.all === "true" || req.body?.all === true;

  // 2. Select target formats to convert
  let targetFormats;
  if (requestedFmtId && FORMAT_MAP[requestedFmtId.toLowerCase()]) {
    targetFormats = [FORMAT_MAP[requestedFmtId.toLowerCase()]];
  } else if (typeFilter === "video" || req.query?.videoOnly === "true") {
    targetFormats = VIDEO_ONLY_FORMATS;
  } else if (typeFilter === "audio" || req.query?.audioOnly === "true") {
    targetFormats = AUDIO_ONLY_FORMATS;
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

    // Preferred primary download link (1080p > 720p > first available video > first available)
    const primary =
      available.find((r) => r.format === "1080") ||
      available.find((r) => r.format === "720") ||
      available.find((r) => r.type === "video") ||
      available[0] ||
      null;

    const primaryDirectUrl = primary
      ? `${baseUrl}/api/youtube?url=${encodeURIComponent(ytUrl)}&format=${primary.format}&dl=true`
      : null;

    // Filter into separate Video (Video + Audio mixed) and Audio-only lists
    const videos = available
      .filter((r) => r.type === "video")
      .map((r) => {
        const directUrl = `${baseUrl}/api/youtube?url=${encodeURIComponent(ytUrl)}&format=${r.format}&dl=true`;
        return {
          format:      r.format,
          quality:     FORMAT_MAP[r.format]?.quality || r.format,
          label:       r.label,
          hasAudio:    true,  // Both video & audio are mixed
          hasVideo:    true,
          downloadUrl: directUrl,
          upstreamUrl: r.downloadUrl,
        };
      });

    const audios = available
      .filter((r) => r.type === "audio")
      .map((r) => {
        const directUrl = `${baseUrl}/api/youtube?url=${encodeURIComponent(ytUrl)}&format=${r.format}&dl=true`;
        return {
          format:      r.format,
          quality:     FORMAT_MAP[r.format]?.quality || r.format,
          label:       r.label,
          hasAudio:    true,
          hasVideo:    false,
          downloadUrl: directUrl,
          upstreamUrl: r.downloadUrl,
        };
      });

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

      // Best Direct Download Link (defaults to highest resolution Video+Audio)
      downloadUrl:   primaryDirectUrl,
      upstreamUrl:   primary ? primary.downloadUrl : null,

      // Deduplicated Lists: Videos (Video + Audio mixed) and Audios (Audio Only)
      videos,
      audios,

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
