/**
 * YouTube All-Quality Downloader — SSBots API
 * Upgraded with y2mate.yt Proof-of-Work (PoW) Engine, Savenow.to Multi-Server Network,
 * Exact YouTube Content-Length/Bitrate Calculation & Full 1080p Stream Support
 * ---------------------------------------------------------------------------------
 * Usage:
 *   GET  /api/youtube?url=https://youtu.be/VIDEO_ID&format=1080
 *   GET  /api/youtube?url=https://youtu.be/VIDEO_ID&format=1080&dl=true (Direct Stream)
 *   POST /api/youtube   body: { "url": "https://youtu.be/VIDEO_ID", "format": "1080" }
 *
 * Supported formats:
 *   Video: 1080, 720, 480, 360, 240, 144, 1440, 4k
 *   Audio: mp3, m4a, aac, flac, opus, ogg, wav
 */

const crypto = require("crypto");
const https = require("https");
const http = require("http");

function getBaseUrl(req) {
  const host = req.headers?.host || (req.get && req.get("host")) || "localhost:3000";
  const proto = req.headers?.["x-forwarded-proto"] || req.protocol || "https";
  return `${proto}://${host}`;
}

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes) || bytes <= 0) return null;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
}

const SAVENOW_API_KEY = "dfcb6d76f2f6a9894gjkege8a4ab232222";
const SAVENOW_BASE = "https://p.savenow.to";
const POLL_INTERVAL_MS = 1200; // poll every 1.2s
const POLL_MAX_TRIES = 35; // max ~42s (ensures 1080p high bitrate conversion completes)
const REQUEST_TIMEOUT = 14000; // 14s per HTTP call

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  Referer: "https://y2mate.yt/",
  Origin: "https://y2mate.yt",
  Accept: "application/json, text/plain, */*",
};

/** Formats registry */
const FORMAT_MAP = {
  "1080": { id: "1080", quality: "1080p", label: "MP4 1080p FHD (Video + Audio)", type: "video", hasAudio: true, hasVideo: true, defaultBitrate: 4200000 },
  "720":  { id: "720",  quality: "720p",  label: "MP4 720p HD (Video + Audio)",   type: "video", hasAudio: true, hasVideo: true, defaultBitrate: 2200000 },
  "480":  { id: "480",  quality: "480p",  label: "MP4 480p SD (Video + Audio)",   type: "video", hasAudio: true, hasVideo: true, defaultBitrate: 1100000 },
  "360":  { id: "360",  quality: "360p",  label: "MP4 360p Low (Video + Audio)",  type: "video", hasAudio: true, hasVideo: true, defaultBitrate: 600000 },
  "240":  { id: "240",  quality: "240p",  label: "MP4 240p Low (Video + Audio)",  type: "video", hasAudio: true, hasVideo: true, defaultBitrate: 350000 },
  "144":  { id: "144",  quality: "144p",  label: "MP4 144p Low (Video + Audio)",  type: "video", hasAudio: true, hasVideo: true, defaultBitrate: 180000 },
  "1440": { id: "1440", quality: "1440p", label: "MP4 1440p 2K (Video + Audio)",  type: "video", hasAudio: true, hasVideo: true, defaultBitrate: 8000000 },
  "4k":   { id: "4k",   quality: "4k",    label: "WEBM 4K UHD (Video + Audio)",   type: "video", hasAudio: true, hasVideo: true, defaultBitrate: 16000000 },
  "2160": { id: "4k",   quality: "4k",    label: "WEBM 4K UHD (Video + Audio)",   type: "video", hasAudio: true, hasVideo: true, defaultBitrate: 16000000 },
  "mp3":  { id: "mp3",  quality: "320kbps", label: "MP3 Audio (320kbps)",         type: "audio", hasAudio: true, hasVideo: false, defaultBitrate: 320000 },
  "m4a":  { id: "m4a",  quality: "128kbps", label: "M4A Audio (Original AAC)",    type: "audio", hasAudio: true, hasVideo: false, defaultBitrate: 128000 },
  "aac":  { id: "aac",  quality: "128kbps", label: "AAC Audio",                   type: "audio", hasAudio: true, hasVideo: false, defaultBitrate: 128000 },
  "flac": { id: "flac", quality: "Lossless", label: "FLAC Audio",                 type: "audio", hasAudio: true, hasVideo: false, defaultBitrate: 900000 },
  "opus": { id: "opus", quality: "160kbps", label: "OPUS Audio",                 type: "audio", hasAudio: true, hasVideo: false, defaultBitrate: 160000 },
  "ogg":  { id: "ogg",  quality: "192kbps", label: "OGG Audio",                   type: "audio", hasAudio: true, hasVideo: false, defaultBitrate: 192000 },
  "wav":  { id: "wav",  quality: "Lossless", label: "WAV Audio",                  type: "audio", hasAudio: true, hasVideo: false, defaultBitrate: 1411200 },
};

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
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        cachedToken = null;
      }
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

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
    `&apikey=${encodeURIComponent(SAVENOW_API_KEY)}`;

  let data;
  try {
    data = await fetchJSON(apiUrl, REQUEST_TIMEOUT, token);
  } catch (err) {
    if (err.message.includes("403") || err.message.includes("401")) {
      cachedToken = null;
      const freshToken = await getValidToken();
      data = await fetchJSON(apiUrl, REQUEST_TIMEOUT, freshToken);
    } else {
      throw err;
    }
  }

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
      continue;
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

// ─── Step 3: Extract YouTube Metadata & Format Sizes ─────────────────────────

async function getYouTubeDetails(videoId) {
  let title = "YouTube Video";
  let authorName = "YouTube Creator";
  let authorUrl = `https://www.youtube.com/watch?v=${videoId}`;
  let thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  let durationSeconds = 0;
  const qualityBytes = {};

  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    const html = await res.text();
    const match = html.match(/ytInitialPlayerResponse\s*=\s*({.+?});(?:var|<\/script>)/);

    if (match) {
      try {
        const data = JSON.parse(match[1]);
        if (data.videoDetails?.title) title = data.videoDetails.title;
        if (data.videoDetails?.author) authorName = data.videoDetails.author;
        if (data.videoDetails?.lengthSeconds) durationSeconds = Number(data.videoDetails.lengthSeconds) || 0;

        const streamingData = data.streamingData || {};
        const formats = (streamingData.formats || []).concat(streamingData.adaptiveFormats || []);

        // Find primary audio track size
        const audioTrack =
          formats.find((f) => f.itag === 140 || (f.mimeType && f.mimeType.includes("audio/mp4"))) ||
          formats.find((f) => f.mimeType && f.mimeType.includes("audio"));
        const audioBytes = audioTrack
          ? Number(audioTrack.contentLength) || Math.round(((Number(audioTrack.bitrate) || 128000) * durationSeconds) / 8)
          : Math.round((128000 * durationSeconds) / 8);

        for (const f of formats) {
          const q = f.qualityLabel ? f.qualityLabel.replace(/p\d+$/, "").replace(/p$/, "") : null;
          if (!q) continue;
          const vBytes = Number(f.contentLength) || Math.round(((Number(f.bitrate) || 0) * durationSeconds) / 8);
          const totalBytes = vBytes + audioBytes;
          if (!qualityBytes[q] || (f.mimeType?.includes("video/mp4") && totalBytes > qualityBytes[q])) {
            qualityBytes[q] = totalBytes;
          }
        }

        if (durationSeconds > 0) {
          qualityBytes["mp3"] = Math.round((320000 * durationSeconds) / 8);
          qualityBytes["m4a"] = audioBytes;
          qualityBytes["aac"] = audioBytes;
          qualityBytes["opus"] = Math.round((160000 * durationSeconds) / 8);
          qualityBytes["ogg"] = Math.round((192000 * durationSeconds) / 8);
          qualityBytes["flac"] = Math.round((900000 * durationSeconds) / 8);
          qualityBytes["wav"] = Math.round((1411200 * durationSeconds) / 8);
        }
      } catch (parseErr) {
        console.warn("JSON player response parse warning:", parseErr.message);
      }
    }

    // Secondary metadata fallback via oEmbed
    if (title === "YouTube Video") {
      try {
        const oembedRes = await fetch(
          `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`
        );
        if (oembedRes.ok) {
          const om = await oembedRes.json();
          if (om.title) title = om.title;
          if (om.author_name) authorName = om.author_name;
          if (om.thumbnail_url) thumbnailUrl = om.thumbnail_url;
        }
      } catch {}
    }
  } catch (err) {
    console.warn("YouTube metadata scrape error:", err.message);
  }

  // Ensure every format in FORMAT_MAP has calculated bytes (never null)
  for (const [key, info] of Object.entries(FORMAT_MAP)) {
    if (!qualityBytes[key]) {
      const dur = durationSeconds > 0 ? durationSeconds : 200; // 200s reasonable default
      qualityBytes[key] = Math.round((info.defaultBitrate * dur) / 8);
    }
  }

  return {
    title,
    authorName,
    authorUrl,
    thumbnailUrl,
    durationSeconds,
    qualityBytes,
  };
}

// ─── Step 4: Process one format end-to-end ───────────────────────────────────

async function processFormat(ytUrl, fmt, token, qualityBytes = {}) {
  try {
    const job = await startDownload(ytUrl, fmt.id, token);

    const calculatedBytes = qualityBytes[fmt.id] || qualityBytes[fmt.quality?.replace("p", "")] || null;
    const sizeStr = calculatedBytes ? formatBytes(calculatedBytes) : null;

    if (job.downloadUrl) {
      return {
        format:      fmt.id,
        label:       fmt.label,
        type:        fmt.type,
        status:      "ready",
        downloadUrl: job.downloadUrl,
        fullFormat:  job.fullFormat || fmt.label,
        size:        sizeStr,
        bytes:       calculatedBytes,
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
      size:        sizeStr,
      bytes:       calculatedBytes,
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

// ─── Step 5: High-Performance Streaming Proxy ────────────────────────────────

function streamMediaDirectly(downloadUrl, title, fmtInfo, req, res, retryYtUrl = null) {
  try {
    let targetUrl = downloadUrl;
    const clientRange = req.headers?.range;

    // Disable all socket and request timeouts for large downloads (1080p, 4k)
    if (req.setTimeout) req.setTimeout(0);
    if (res.setTimeout) res.setTimeout(0);
    if (req.socket && req.socket.setTimeout) req.socket.setTimeout(0);
    if (res.socket && res.socket.setTimeout) res.socket.setTimeout(0);

    const requestHeaders = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      Referer: "https://y2mate.yt/",
      Origin: "https://y2mate.yt",
      Accept: "*/*",
      Connection: "keep-alive",
    };
    if (clientRange) {
      requestHeaders["Range"] = clientRange;
    }

    const parsed = new URL(targetUrl);
    const transport = parsed.protocol === "https:" ? https : http;

    const upstreamReq = transport.request(
      targetUrl,
      {
        method: req.method === "HEAD" ? "HEAD" : "GET",
        headers: requestHeaders,
        timeout: 0,
      },
      async (upstreamRes) => {
        // Follow redirects if any
        if (
          upstreamRes.statusCode >= 300 &&
          upstreamRes.statusCode < 400 &&
          upstreamRes.headers.location
        ) {
          return streamMediaDirectly(
            upstreamRes.headers.location,
            title,
            fmtInfo,
            req,
            res,
            retryYtUrl
          );
        }

        const contentType = upstreamRes.headers["content-type"] || "";

        // If upstream redirected to an ad HTML page or expired token, re-mint token if retryYtUrl available
        if (contentType.includes("text/html") || upstreamRes.statusCode >= 400) {
          if (retryYtUrl) {
            cachedToken = null;
            const freshToken = await getValidToken();
            const freshJob = await processFormat(retryYtUrl, fmtInfo, freshToken);
            if (freshJob && freshJob.status === "ready" && freshJob.downloadUrl) {
              return streamMediaDirectly(
                freshJob.downloadUrl,
                title,
                fmtInfo,
                req,
                res,
                null
              );
            }
          }

          return sendJson(res, 502, {
            success: false,
            error:
              "Upstream media server returned an expired or invalid link. Please refresh.",
          });
        }

        const finalContentType =
          contentType || (fmtInfo?.type === "audio" ? "audio/mpeg" : "video/mp4");
        const ext =
          fmtInfo?.type === "audio" ? (fmtInfo.id === "m4a" ? "m4a" : "mp3") : "mp4";
        const cleanTitle =
          (title || "video").replace(/[^\w\s\-\.\u0900-\u097F]/gi, "").trim() ||
          "download";
        const filename = `${cleanTitle}.${ext}`;

        const statusCode = upstreamRes.statusCode || (clientRange ? 206 : 200);
        res.status(statusCode);

        res.setHeader("Content-Type", finalContentType);
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`
        );
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Accept-Ranges", "bytes");

        // Forward Range headers
        const contentRange = upstreamRes.headers["content-range"];
        if (contentRange) {
          res.setHeader("Content-Range", contentRange);
        }

        // Set Content-Length: from upstream header, or from pre-calculated format bytes
        let contentLength = upstreamRes.headers["content-length"];
        if (!contentLength && fmtInfo?.bytes && !clientRange) {
          contentLength = String(fmtInfo.bytes);
        }

        if (contentLength) {
          res.setHeader("Content-Length", contentLength);
        }

        if (req.method === "HEAD") {
          return res.end();
        }

        // Pipe upstream stream directly to client response
        upstreamRes.pipe(res);

        upstreamRes.on("error", (err) => {
          console.error("Upstream stream error:", err.message);
          if (!res.writableEnded) res.end();
        });

        res.on("close", () => {
          upstreamReq.destroy();
        });
      }
    );

    upstreamReq.on("error", (err) => {
      console.error("Upstream connection error:", err.message);
      if (!res.headersSent) {
        sendJson(res, 502, {
          success: false,
          error: `Streaming connection failed: ${err.message}`,
        });
      }
    });

    upstreamReq.end();
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

function getRequestedFormat(req) {
  if (req.method === "POST" && req.body && req.body.format) {
    return String(req.body.format).trim();
  }
  if (req.query && req.query.format) {
    return String(req.query.format).trim();
  }
  return null;
}

function getRequestedUrl(req) {
  if (req.method === "POST" && req.body && req.body.url) {
    return String(req.body.url).trim();
  }
  if (req.query && req.query.url) {
    return String(req.query.url).trim();
  }
  return null;
}

function sendJson(res, statusCode, data) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.status(statusCode).json(data);
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
    return res.status(204).end();
  }

  if (!["GET", "POST", "HEAD"].includes(req.method)) {
    return sendJson(res, 405, { success: false, error: "Method not allowed. Use GET, POST, or HEAD." });
  }

  // Support direct proxy streaming if requested
  if (req.query?.proxy) {
    const proxyUrl = req.query.proxy;
    const title = req.query.title || "video";
    const bytes = Number(req.query.bytes) || null;
    const fmt = { id: req.query.format || "720", type: req.query.type || "video", bytes };
    const retryYt = req.query.ytUrl ? decodeURIComponent(req.query.ytUrl) : null;
    return streamMediaDirectly(proxyUrl, title, fmt, req, res, retryYt);
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

  // If client wants direct media stream with accurate Content-Length & Range support
  if (isDirectDownload) {
    const targetFmt = FORMAT_MAP[requestedFmtId ? requestedFmtId.toLowerCase() : "1080"] || FORMAT_MAP["1080"];
    try {
      const [token, ytDetails] = await Promise.all([
        getValidToken(),
        getYouTubeDetails(videoId),
      ]);
      const job = await processFormat(ytUrl, targetFmt, token, ytDetails.qualityBytes);

      if (job && job.status === "ready" && job.downloadUrl) {
        targetFmt.bytes = job.bytes;
        return streamMediaDirectly(job.downloadUrl, ytDetails.title, targetFmt, req, res, ytUrl);
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
    // 3. Acquire valid y2mate / savenow PoW token and YouTube video metadata
    const [token, ytDetails] = await Promise.all([
      getValidToken(),
      getYouTubeDetails(videoId),
    ]);

    // 4. Fetch formats in parallel with calculated bytes
    const formatResults = await Promise.all(
      targetFormats.map((fmt) => processFormat(ytUrl, fmt, token, ytDetails.qualityBytes))
    );

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
        const directProxyUrl = `${baseUrl}/api/youtube?url=${encodeURIComponent(ytUrl)}&format=${r.format}&dl=true`;
        return {
          format:      r.format,
          quality:     FORMAT_MAP[r.format]?.quality || `${r.format}p`,
          label:       r.label,
          hasAudio:    true,
          hasVideo:    true,
          size:        r.size,
          bytes:       r.bytes,
          downloadUrl: directProxyUrl,
          directUrl:   r.downloadUrl,
          upstreamUrl: r.downloadUrl,
          cdnUrl:      r.downloadUrl,
        };
      });

    const audios = available
      .filter((r) => r.type === "audio")
      .map((r) => {
        const directProxyUrl = `${baseUrl}/api/youtube?url=${encodeURIComponent(ytUrl)}&format=${r.format}&dl=true`;
        return {
          format:      r.format,
          quality:     FORMAT_MAP[r.format]?.quality || r.format,
          label:       r.label,
          hasAudio:    true,
          hasVideo:    false,
          size:        r.size,
          bytes:       r.bytes,
          downloadUrl: directProxyUrl,
          directUrl:   r.downloadUrl,
          upstreamUrl: r.downloadUrl,
          cdnUrl:      r.downloadUrl,
        };
      });

    // Clean unified download list
    const downloadLinks = available.map((r) => {
      const directProxyUrl = `${baseUrl}/api/youtube?url=${encodeURIComponent(ytUrl)}&format=${r.format}&dl=true`;
      return {
        format:      r.format,
        quality:     FORMAT_MAP[r.format]?.quality || r.format,
        label:       r.label,
        type:        r.type,
        hasAudio:    true,
        hasVideo:    r.type === "video",
        size:        r.size,
        bytes:       r.bytes,
        downloadUrl: directProxyUrl,
        directUrl:   r.downloadUrl,
        upstreamUrl: r.downloadUrl,
        cdnUrl:      r.downloadUrl,
      };
    });

    return sendJson(res, 200, {
      success:       available.length > 0,
      videoId,
      sourceUrl:     requestedUrl,
      watchUrl:      ytUrl,
      embedUrl:      `https://www.youtube.com/embed/${videoId}`,
      title:         ytDetails.title,
      authorName:    ytDetails.authorName,
      authorUrl:     ytDetails.authorUrl,
      thumbnailUrl:  ytDetails.thumbnailUrl,
      durationSeconds: ytDetails.durationSeconds,

      // Best Direct Download Link (defaults to 1080p / highest resolution)
      downloadUrl:   primaryDirectUrl,
      directUrl:     primary ? primary.downloadUrl : null,
      upstreamUrl:   primary ? primary.downloadUrl : null,
      cdnUrl:        primary ? primary.downloadUrl : null,
      size:          primary?.size,
      bytes:         primary?.bytes,

      // Categorized & Deduplicated Lists
      videos,
      audios,

      // Clean unified download list
      downloadLinks,

      // Formats compatibility alias
      formats: downloadLinks,

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
