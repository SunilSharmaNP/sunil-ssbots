/**
 * TeraBox Streaming & Direct Download Link Extractor
 * Powered by DragoXStream (https://dragoplayer.in)
 * ----------------------------------------------------
 * Usage:
 *   GET  /api/terabox?url=https://teraboxapp.com/s/...
 *   POST /api/terabox   body: { "url": "https://teraboxapp.com/s/..." }
 *
 * Returns:
 *   - details: full file metadata (name, size, quality, provider, expires_at)
 *   - name: video title / file name
 *   - size: formatted human-readable size
 *   - quality: video resolution (e.g. 1080p, 720p, 480p)
 *   - ddl: direct download link (https://dragoplayer.in/api/download?h=...)
 *   - streaming_link: HLS streaming playlist (https://dragoplayer.in/api/hls?h=...)
 *   - stream_url: progressive video stream (https://dragoplayer.in/api/stream?h=...)
 *   - items: list of all files/qualities found
 */

const crypto = require("crypto");

const DRAGO_BASE = "https://dragoplayer.in";
const RESOLVE_ENDPOINT = `${DRAGO_BASE}/api/resolve`;

const TERABOX_DOMAINS = [
  "1024-terabox.com",
  "1024tera.com",
  "freeterabox.com",
  "terabox.app",
  "terabox.club",
  "terabox.com",
  "terabox.link",
  "teraboxapp.com",
  "teraboxapp.xyz",
  "teraboxfree.com",
  "teraboxlink.com",
  "teraboxlinke.com",
  "teraboxshare.com",
  "teraboxurl.com",
  "mirrobox.com",
  "nephobox.com",
  "4funbox.com",
];

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes) || bytes <= 0) return null;
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function makeAbsoluteUrl(pathOrUrl) {
  if (!pathOrUrl || typeof pathOrUrl !== "string") return null;
  const trimmed = pathOrUrl.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }
  if (trimmed.startsWith("/")) {
    return `${DRAGO_BASE}${trimmed}`;
  }
  return `${DRAGO_BASE}/${trimmed}`;
}

function normalizeTeraboxUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  let urlStr = rawUrl.trim();
  if (!/^https?:\/\//i.test(urlStr)) {
    urlStr = `https://${urlStr}`;
  }
  return urlStr;
}

function generateRequestId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 6)
  );
}

module.exports = async function handler(req, res) {
  // CORS & Preflight
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Parse input URL
  let targetUrl = req.query?.url;
  if (!targetUrl && req.body) {
    if (typeof req.body === "string") {
      try {
        targetUrl = JSON.parse(req.body)?.url;
      } catch {
        targetUrl = null;
      }
    } else {
      targetUrl = req.body?.url;
    }
  }

  if (!targetUrl || typeof targetUrl !== "string" || targetUrl.trim().length === 0) {
    return res.status(400).json({
      success: false,
      error: "TeraBox URL is required in 'url' parameter (GET query or POST body)",
      example: "https://teraboxapp.com/s/1xxxxxx",
    });
  }

  const normalizedUrl = normalizeTeraboxUrl(targetUrl);

  try {
    const startTime = Date.now();
    const requestId = generateRequestId();

    // Call DragoPlayer's /api/resolve endpoint with 20s timeout
    const response = await fetch(RESOLVE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: DRAGO_BASE,
        Referer: `${DRAGO_BASE}/`,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "X-Request-ID": requestId,
      },
      body: JSON.stringify({ url: normalizedUrl }),
      signal: AbortSignal.timeout(20000),
    });

    let data;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok || !data) {
      const errCode = data?.error?.code || `HTTP_${response.status}`;
      const errMsg =
        data?.error?.message ||
        "DragoPlayer resolver did not return a valid response for this TeraBox link.";
      return res.status(response.status >= 400 && response.status < 600 ? response.status : 502).json({
        success: false,
        error: errMsg,
        code: errCode,
        requestId: data?.request_id || requestId,
        source: "dragoplayer.in",
      });
    }

    if (data.error) {
      return res.status(400).json({
        success: false,
        error: data.error.message || "Failed to resolve link",
        code: data.error.code || "resolve_error",
        source: "dragoplayer.in",
      });
    }

    const items = Array.isArray(data.items) ? data.items : [];
    if (items.length === 0) {
      return res.status(404).json({
        success: false,
        error: "No playable or downloadable media found behind this link.",
        source: "dragoplayer.in",
        raw: data,
      });
    }

    // Format all items
    const formattedItems = items.map((item, idx) => {
      const fileName = item.file_name || `TeraBox_File_${idx + 1}`;
      const sizeBytes = item.size_bytes || null;
      const sizeHuman = item.size_human || formatBytes(sizeBytes) || "Unknown";
      const quality = item.quality ? String(item.quality) : "HD";

      const hlsUrl = makeAbsoluteUrl(item.hls_url);
      const streamUrl = makeAbsoluteUrl(item.stream_url);
      const downloadUrl = makeAbsoluteUrl(item.download_url);
      const thumbUrl = makeAbsoluteUrl(item.thumb_url);

      // Primary streaming link (HLS playlist preferred like https://dragoplayer.in/api/hls?h=...)
      const streamingLink = hlsUrl || streamUrl;

      return {
        id: item.id || `item_${idx + 1}`,
        name: fileName,
        file_name: fileName,
        size: sizeHuman,
        size_human: sizeHuman,
        size_bytes: sizeBytes,
        quality: quality,
        kind: item.kind || "video",
        thumb_url: thumbUrl,
        streaming_link: streamingLink,
        hls_url: hlsUrl,
        stream_url: streamUrl,
        ddl: downloadUrl,
        download_url: downloadUrl,
      };
    });

    const primary = formattedItems[0];
    const durationMs = Date.now() - startTime;

    // Build consolidated downloadLinks array for frontend cards & UI
    const downloadLinks = [];
    formattedItems.forEach((it, idx) => {
      const prefix = formattedItems.length > 1 ? `[#${idx + 1}] ` : "";

      if (it.hls_url) {
        downloadLinks.push({
          label: `${prefix}HLS Adaptive Stream (${it.quality})`,
          format: "HLS (m3u8)",
          type: "hls_stream",
          downloadUrl: it.hls_url,
          size: it.size,
        });
      }

      if (it.stream_url && it.stream_url !== it.hls_url) {
        downloadLinks.push({
          label: `${prefix}Direct Progressive Video Stream`,
          format: "MP4 Stream",
          type: "progressive_stream",
          downloadUrl: it.stream_url,
          size: it.size,
        });
      }

      if (it.ddl) {
        downloadLinks.push({
          label: `${prefix}Direct Download Link (DDL)`,
          format: "Direct Download",
          type: "ddl",
          downloadUrl: it.ddl,
          size: it.size,
        });
      }
    });

    // Final response
    return res.status(200).json({
      success: true,
      service: "terabox",
      provider: data.provider || "terabox",

      // Direct metadata fields requested by user
      name: primary.name,
      file_name: primary.file_name,
      title: primary.name,
      size: primary.size,
      size_human: primary.size_human,
      size_bytes: primary.size_bytes,
      quality: primary.quality,

      // Streaming links (exact format: https://dragoplayer.in/api/hls?h=...)
      streaming_link: primary.streaming_link,
      hls_url: primary.hls_url,
      stream_url: primary.stream_url,

      // Direct download link (ddl)
      ddl: primary.ddl,
      download_url: primary.download_url,

      // Media thumbnail
      thumb_url: primary.thumb_url,
      thumbnailUrl: primary.thumb_url,

      // Complete details object
      details: {
        provider: data.provider || "terabox",
        name: primary.name,
        size: primary.size,
        size_bytes: primary.size_bytes,
        quality: primary.quality,
        kind: primary.kind,
        total_files: formattedItems.length,
        expires_at: data.expires_at || null,
        duration_ms: durationMs,
        resolver: "dragoplayer.in",
      },

      // Items list (for multi-file folders/albums)
      items: formattedItems,

      // Links list for frontend UI
      downloadLinks,

      // Original URL and timing
      original_url: normalizedUrl,
      sourceUrl: normalizedUrl,
      durationMs,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: "Internal server error while resolving TeraBox link",
      details: err.message,
      source: "dragoplayer.in",
    });
  }
};
