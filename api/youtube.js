/**
 * YouTube All-Quality Direct Downloader (DDL) API
 * High-Speed Ad-Free Stream & Format Extractor
 * ---------------------------------------------------------------------------------
 * Extracts authentic, direct download links (DDL) for 1080p Full HD, 720p, 480p,
 * 360p, 4K, and MP3 / M4A audio streams without spam, ad popups, or fake redirects.
 *
 * Usage:
 *   GET  /api/youtube?url=https://youtu.be/VIDEO_ID&quality=1080
 *   POST /api/youtube   body: { "url": "https://youtu.be/VIDEO_ID", "quality": "1080" }
 */

const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");

const YOUTUBE_HOSTS = new Set([
  "www.youtube.com",
  "youtube.com",
  "m.youtube.com",
  "youtu.be",
  "music.youtube.com",
]);

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function getVideoId(input) {
  if (typeof input !== "string" || input.trim().length === 0) return null;

  let url;
  try {
    url = new URL(input.trim());
  } catch {
    // If just an ID was passed
    if (/^[A-Za-z0-9_-]{11}$/.test(input.trim())) {
      return input.trim();
    }
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
    pathParts[0] === "shorts" || pathParts[0] === "embed" || pathParts[0] === "v"
      ? pathParts[1]
      : null;

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
  return q ? String(q).trim().toLowerCase() : "1080";
}

function sendJson(res, status, data) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return res.status(status).json(data);
}

function formatDuration(sec) {
  if (!sec || isNaN(sec)) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return null;
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/**
 * Extracts YouTube video information and authentic direct stream URLs
 */
function extractWithYtDlp(ytUrl) {
  return new Promise((resolve, reject) => {
    // Resolve yt-dlp binary path
    const candidatePaths = [
      path.join(process.cwd(), "bin", "yt-dlp"),
      "/tmp/yt-dlp",
      "/usr/local/bin/yt-dlp",
      "/usr/bin/yt-dlp",
    ];

    let binPath = candidatePaths.find((p) => fs.existsSync(p));
    if (!binPath) {
      binPath = "yt-dlp";
    }

    const nodePath = fs.existsSync("/usr/local/bin/node")
      ? "/usr/local/bin/node"
      : process.execPath;

    const args = [
      "--js-runtimes",
      `node:${nodePath}`,
      "--dump-single-json",
      "--no-warnings",
      "--no-playlist",
      ytUrl,
    ];

    execFile(
      binPath,
      args,
      { maxBuffer: 15 * 1024 * 1024, timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) {
          return reject(
            new Error(
              `Extraction error: ${stderr || err.message || "Failed to execute extractor"}`
            )
          );
        }

        try {
          const data = JSON.parse(stdout);
          resolve(data);
        } catch (parseErr) {
          reject(new Error("Failed to parse extractor output JSON"));
        }
      }
    );
  });
}

/**
 * Fallback oEmbed metadata if needed
 */
async function getYouTubeOEmbed(videoId) {
  const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      return {
        title: data.title || "YouTube Video",
        author: data.author_name || "Creator",
        thumbnail:
          data.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
      };
    }
  } catch {
    // ignore
  }
  return {
    title: "YouTube Video",
    author: "Creator",
    thumbnail: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
  };
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }

  const requestedUrl = getRequestedUrl(req);
  const videoId = getVideoId(requestedUrl);

  if (!videoId) {
    return sendJson(res, 400, {
      success: false,
      error: "A valid YouTube URL is required in 'url' parameter.",
      examples: [
        "/api/youtube?url=https://youtu.be/dQw4w9WgXcQ",
        "/api/youtube?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&quality=1080",
      ],
    });
  }

  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const requestedQuality = getRequestedQuality(req);
  const startTime = Date.now();

  try {
    // Run direct ad-free extraction engine
    const info = await extractWithYtDlp(ytUrl);

    const formats = info.formats || [];

    // Filter useful formats (progressive video+audio and separate high-res streams)
    const processedFormats = [];
    const downloadLinks = [];

    // 1. Progressive streams (Format 18 / 22 has video + audio in one file, ready for instant play/download)
    const progressiveFormats = formats.filter(
      (f) => f.vcodec !== "none" && f.acodec !== "none" && f.url
    );

    // 2. Separate video streams (1080p, 720p, etc.)
    const videoStreams = formats.filter(
      (f) => f.vcodec !== "none" && f.url && f.height
    );

    // 3. Audio only streams (m4a, opus, mp3)
    const audioStreams = formats.filter(
      (f) => f.vcodec === "none" && f.acodec !== "none" && f.url
    );

    // Sort video streams by height descending
    videoStreams.sort((a, b) => (b.height || 0) - (a.height || 0));

    // Best progressive stream (usually format 18 at 360p or format 22 at 720p)
    const bestProgressive =
      progressiveFormats.find((f) => f.height === 720) ||
      progressiveFormats.find((f) => f.height === 360) ||
      progressiveFormats[0];

    // Find requested quality format
    let targetFormat = null;
    if (requestedQuality === "mp3" || requestedQuality.includes("audio")) {
      targetFormat =
        audioStreams.find((f) => f.ext === "m4a") ||
        audioStreams[0] ||
        bestProgressive;
    } else {
      const targetHeight = parseInt(requestedQuality, 10);
      if (!isNaN(targetHeight)) {
        targetFormat =
          videoStreams.find((f) => f.height === targetHeight) ||
          progressiveFormats.find((f) => f.height === targetHeight);
      }
    }

    // Default primary direct download URL:
    // Prefer targetFormat URL, or bestProgressive URL
    const directDownloadUrl =
      targetFormat?.url || bestProgressive?.url || videoStreams[0]?.url || null;

    // Build user-friendly downloadLinks cards
    if (bestProgressive?.url) {
      downloadLinks.push({
        format: `${bestProgressive.height || 360}p`,
        label: `⚡ Instant MP4 (${bestProgressive.height || 360}p Video + Audio - No Ads)`,
        type: "progressive",
        quality: `${bestProgressive.height || 360}p`,
        filesize: formatBytes(bestProgressive.filesize || bestProgressive.filesize_approx),
        url: bestProgressive.url,
        downloadUrl: bestProgressive.url,
        verified: true,
      });
    }

    // Add standard resolutions (1080p, 720p, 480p, 360p)
    const distinctHeights = [1080, 720, 480, 360];
    for (const h of distinctHeights) {
      const f = videoStreams.find((v) => v.height === h);
      if (f && f.url) {
        downloadLinks.push({
          format: `${h}p`,
          label: `HD ${h}p Direct Stream (${f.ext || "mp4"})`,
          type: "video",
          quality: `${h}p`,
          filesize: formatBytes(f.filesize || f.filesize_approx),
          url: f.url,
          downloadUrl: f.url,
          verified: true,
        });
      }
    }

    // Add audio option
    const bestAudio =
      audioStreams.find((a) => a.ext === "m4a") || audioStreams[0];
    if (bestAudio?.url) {
      downloadLinks.push({
        format: "audio",
        label: `🎵 High-Quality Audio (${bestAudio.ext || "m4a"})`,
        type: "audio",
        quality: `${Math.round(bestAudio.abr || 128)}kbps`,
        filesize: formatBytes(bestAudio.filesize || bestAudio.filesize_approx),
        url: bestAudio.url,
        downloadUrl: bestAudio.url,
        verified: true,
      });
    }

    // Build format table list
    for (const f of formats) {
      if (!f.url) continue;
      const isVideo = f.vcodec !== "none";
      const isAudio = f.acodec !== "none";
      processedFormats.push({
        format_id: f.format_id,
        resolution: f.resolution || (f.height ? `${f.height}p` : "audio only"),
        ext: f.ext,
        filesize: formatBytes(f.filesize || f.filesize_approx) || "Auto",
        vcodec: f.vcodec !== "none" ? f.vcodec : undefined,
        acodec: f.acodec !== "none" ? f.acodec : undefined,
        url: f.url,
      });
    }

    const responsePayload = {
      success: true,
      service: "youtube",
      provider: "direct_stream_engine",
      videoId,
      title: info.title || "YouTube Video",
      channel: info.uploader || info.channel || "YouTube Creator",
      authorName: info.uploader || info.channel || "YouTube Creator",
      thumbnailUrl:
        info.thumbnail || `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
      duration: info.duration || 0,
      durationStr: formatDuration(info.duration),
      sourceUrl: ytUrl,
      watchUrl: ytUrl,
      embedUrl: `https://www.youtube.com/embed/${videoId}`,
      directDownloadUrl: directDownloadUrl,
      downloadUrl: directDownloadUrl,
      downloadLinks,
      formats: processedFormats.slice(0, 20),
      mirrors: [
        {
          name: "🌐 Y2Mate Web Mirror (External Browser Portal)",
          type: "web_mirror",
          url: `https://v38.www-y2mate.com/`,
        },
        {
          name: "⚡ 1-Click Direct Stream (0 Ads / Pure CDN)",
          type: "direct_stream",
          url: directDownloadUrl,
        },
      ],
      notice: "Direct GoogleVideo CDN stream extracted successfully without ads.",
      durationMs: Date.now() - startTime,
    };

    return sendJson(res, 200, responsePayload);
  } catch (err) {
    console.error("YouTube direct extraction error:", err);

    // Fallback to oembed and helpful notice if video is restricted or deleted
    const oembed = await getYouTubeOEmbed(videoId);
    return sendJson(res, 200, {
      success: true,
      service: "youtube",
      provider: "fallback_portal",
      videoId,
      title: oembed.title,
      channel: oembed.author,
      thumbnailUrl: oembed.thumbnail,
      sourceUrl: ytUrl,
      downloadUrl: `https://v38.www-y2mate.com/`,
      mirrors: [
        {
          name: "🌐 Y2Mate Portal Mirror",
          type: "web_mirror",
          url: `https://v38.www-y2mate.com/`,
        },
      ],
      downloadLinks: [],
      errorNotice: err.message,
      notice: "Could not extract direct stream URL (video might be geo-restricted or age-restricted). Use web mirror portal.",
      durationMs: Date.now() - startTime,
    });
  }
};
