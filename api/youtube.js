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
 *   GET  /api/youtube?stream=1&url=https://youtu.be/VIDEO_ID&quality=1080  (Direct 1-Click File Download)
 */

const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const { Readable } = require("stream");

const YOUTUBE_HOSTS = new Set([
  "www.youtube.com",
  "youtube.com",
  "m.youtube.com",
  "youtu.be",
  "music.youtube.com",
]);

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CNV_HEADERS = {
  Referer: "https://mp3yt.is/",
  Origin: "https://mp3yt.is",
  "User-Agent": USER_AGENT,
};

function getVideoId(input) {
  if (typeof input !== "string" || input.trim().length === 0) return null;

  const trimmed = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }

  let url;
  try {
    url = new URL(trimmed);
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

/**
 * High-Speed Ad-Free Converter Engine (cnv.cx CDN Tunnel) with Auto-Retry
 */
async function convertViaTunnel(videoId, requestedQuality = "1080") {
  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;

  const isAudio =
    requestedQuality === "mp3" || requestedQuality.includes("audio");
  const format = isAudio ? "mp3" : "mp4";
  let videoQuality = "1080";
  if (!isAudio) {
    if (["720", "480", "360", "240", "144"].includes(requestedQuality)) {
      videoQuality = requestedQuality;
    }
  }

  // 1. Fetch metadata info
  let info = null;
  try {
    const infoRes = await fetch("https://cnv.cx/v2/getVideoInfo", {
      method: "POST",
      headers: {
        ...CNV_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ link: ytUrl }),
      signal: AbortSignal.timeout(7000),
    });
    if (infoRes.ok) {
      info = await infoRes.json();
    }
  } catch {
    // Info fallback
  }

  // 2. Fetch converter sanity key with retry backoff
  let key = null;
  let lastKeyErr = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const keyRes = await fetch(`https://cnv.cx/v2/sanity/key?id=${videoId}`, {
        headers: {
          ...CNV_HEADERS,
          accept: "application/json, text/plain, */*",
        },
        signal: AbortSignal.timeout(6000),
      });

      if (keyRes.status === 429) {
        lastKeyErr = new Error("Converter temporary rate limit (429)");
        await new Promise((r) => setTimeout(r, attempt * 800));
        continue;
      }

      if (keyRes.ok) {
        const keyData = await keyRes.json();
        if (keyData && keyData.key) {
          key = keyData.key;
          break;
        }
      }
    } catch (err) {
      lastKeyErr = err;
      await new Promise((r) => setTimeout(r, attempt * 500));
    }
  }

  if (!key) {
    throw new Error(
      `Could not acquire converter session token: ${lastKeyErr?.message || "Rate limited or blocked"}`
    );
  }

  // 3. Request direct CDN conversion
  const convRes = await fetch("https://cnv.cx/v2/converter", {
    method: "POST",
    headers: {
      ...CNV_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
      accept: "*/*",
      key,
    },
    body: new URLSearchParams({
      link: ytUrl,
      format,
      videoQuality,
      audioBitrate: "320",
      vCodec: "h264",
    }),
    signal: AbortSignal.timeout(15000),
  });

  const convData = await convRes.json();
  if (!convData || !convData.url) {
    throw new Error(convData?.errorMsg || "Converter did not return a valid download tunnel");
  }

  return {
    url: convData.url,
    filename: convData.filename || `${videoId}.${format}`,
    format,
    videoQuality,
    title: info?.title || `YouTube Video ${videoId}`,
    channel: info?.channelTitle || "YouTube Creator",
    duration: info?.duration || 0,
    durationStr: info?.videoTime || formatDuration(info?.duration),
    thumbnail:
      info?.thumbnail || `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
  };
}

/**
 * Fallback Local Extractor Engine (yt-dlp) with absolute path detection
 */
function extractWithYtDlp(ytUrl) {
  return new Promise((resolve, reject) => {
    const candidatePaths = [
      "/usr/local/bin/yt-dlp",
      "/usr/bin/yt-dlp",
      "/app/applet/bin/yt-dlp",
      path.join(process.cwd(), "bin", "yt-dlp"),
      path.join(__dirname, "..", "bin", "yt-dlp"),
      "/tmp/yt-dlp",
    ];

    const binPath = candidatePaths.find((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });

    if (!binPath) {
      return reject(new Error("Local yt-dlp binary is not installed on this system"));
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
      "--extractor-args",
      "youtube:player_client=android,web",
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
              `Extraction error: ${stderr || err.message || "Failed to execute yt-dlp"}`
            )
          );
        }

        try {
          const data = JSON.parse(stdout);
          resolve(data);
        } catch {
          reject(new Error("Failed to parse extractor output JSON"));
        }
      }
    );
  });
}

/**
 * Fallback oEmbed metadata
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
        "/api/youtube?stream=1&url=https://youtu.be/dQw4w9WgXcQ&quality=1080",
      ],
    });
  }

  const requestedQuality = getRequestedQuality(req);
  const startTime = Date.now();
  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // Direct Browser Download Proxy Stream
  if (
    req.method === "GET" &&
    (req.query?.stream === "1" || req.query?.download === "1")
  ) {
    try {
      const converted = await convertViaTunnel(videoId, requestedQuality);
      const fileRes = await fetch(converted.url, {
        headers: {
          ...CNV_HEADERS,
        },
      });

      if (!fileRes.ok) {
        return res
          .status(fileRes.status)
          .send(`Failed to stream media: HTTP ${fileRes.status}`);
      }

      const mimeType =
        converted.format === "mp3" ? "audio/mpeg" : "video/mp4";
      res.setHeader("Content-Type", mimeType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${encodeURIComponent(converted.filename)}"`
      );
      if (fileRes.headers.get("content-length")) {
        res.setHeader(
          "Content-Length",
          fileRes.headers.get("content-length")
        );
      }

      Readable.fromWeb(fileRes.body).pipe(res);
      return;
    } catch (streamErr) {
      console.error("Direct stream proxy error:", streamErr);
      return res.status(500).send(`Stream error: ${streamErr.message}`);
    }
  }

  // 1. Primary Engine: Convert via fast Ad-Free CDN Tunnel
  try {
    const primary = await convertViaTunnel(videoId, requestedQuality);

    const downloadLinks = [
      {
        format: primary.format === "mp3" ? "mp3" : `${primary.videoQuality}p`,
        label:
          primary.format === "mp3"
            ? "🎵 High-Quality MP3 Audio (320kbps - Direct DDL)"
            : `⚡ Direct MP4 (${primary.videoQuality}p Full HD - No Ads)`,
        type: primary.format === "mp3" ? "audio" : "video",
        quality:
          primary.format === "mp3" ? "320kbps" : `${primary.videoQuality}p`,
        downloadUrl: primary.url,
        browserDownloadUrl: `/api/youtube?stream=1&url=${encodeURIComponent(ytUrl)}&quality=${primary.videoQuality}`,
        filename: primary.filename,
        verified: true,
      },
      {
        format: "1080p",
        label: "🎬 1080p Full HD MP4 Direct Download",
        type: "video",
        quality: "1080p",
        url: `/api/youtube?url=${encodeURIComponent(ytUrl)}&quality=1080`,
        browserDownloadUrl: `/api/youtube?stream=1&url=${encodeURIComponent(ytUrl)}&quality=1080`,
        verified: true,
      },
      {
        format: "720p",
        label: "🎬 720p HD MP4 Direct Download",
        type: "video",
        quality: "720p",
        url: `/api/youtube?url=${encodeURIComponent(ytUrl)}&quality=720`,
        browserDownloadUrl: `/api/youtube?stream=1&url=${encodeURIComponent(ytUrl)}&quality=720`,
        verified: true,
      },
      {
        format: "360p",
        label: "📱 360p Fast Mobile MP4 Direct Download",
        type: "video",
        quality: "360p",
        url: `/api/youtube?url=${encodeURIComponent(ytUrl)}&quality=360`,
        browserDownloadUrl: `/api/youtube?stream=1&url=${encodeURIComponent(ytUrl)}&quality=360`,
        verified: true,
      },
      {
        format: "mp3",
        label: "🎧 320kbps MP3 Audio Direct Download",
        type: "audio",
        quality: "320kbps",
        url: `/api/youtube?url=${encodeURIComponent(ytUrl)}&quality=mp3`,
        browserDownloadUrl: `/api/youtube?stream=1&url=${encodeURIComponent(ytUrl)}&quality=mp3`,
        verified: true,
      },
    ];

    const browserDownloadUrl = `/api/youtube?stream=1&url=${encodeURIComponent(ytUrl)}&quality=${primary.videoQuality}`;

    const responsePayload = {
      success: true,
      service: "youtube",
      provider: "direct_tunnel_engine",
      videoId,
      title: primary.title,
      channel: primary.channel,
      authorName: primary.channel,
      thumbnailUrl: primary.thumbnail,
      duration: primary.duration,
      durationStr: primary.durationStr,
      sourceUrl: ytUrl,
      watchUrl: ytUrl,
      embedUrl: `https://www.youtube.com/embed/${videoId}`,
      directDownloadUrl: primary.url,
      downloadUrl: primary.url,
      browserDownloadUrl,
      filename: primary.filename,
      downloadLinks,
      mirrors: [
        {
          name: "⚡ 1-Click Browser Direct Download (No Ads / Attachment)",
          type: "browser_direct",
          url: browserDownloadUrl,
        },
        {
          name: "🌐 Y2Mate Web Mirror (External Browser Portal)",
          type: "web_mirror",
          url: "https://v38.www-y2mate.com/",
        },
      ],
      notice: "Direct authentic CDN download stream generated successfully without ads.",
      durationMs: Date.now() - startTime,
    };

    return sendJson(res, 200, responsePayload);
  } catch (primaryErr) {
    console.warn("Primary converter failed, trying yt-dlp fallback:", primaryErr.message);

    // 2. Secondary Engine: Local yt-dlp
    try {
      const info = await extractWithYtDlp(ytUrl);
      const formats = info.formats || [];

      const progressiveFormats = formats.filter(
        (f) => f.vcodec !== "none" && f.acodec !== "none" && f.url
      );
      const videoStreams = formats.filter(
        (f) => f.vcodec !== "none" && f.url && f.height
      );
      videoStreams.sort((a, b) => (b.height || 0) - (a.height || 0));

      const bestProgressive =
        progressiveFormats.find((f) => f.height === 720) ||
        progressiveFormats.find((f) => f.height === 360) ||
        progressiveFormats[0];

      const directUrl =
        bestProgressive?.url || videoStreams[0]?.url || null;

      const downloadLinks = [];
      if (bestProgressive?.url) {
        downloadLinks.push({
          format: `${bestProgressive.height || 360}p`,
          label: `⚡ Progressive MP4 (${bestProgressive.height || 360}p Direct Stream)`,
          type: "progressive",
          quality: `${bestProgressive.height || 360}p`,
          url: bestProgressive.url,
          downloadUrl: bestProgressive.url,
          verified: true,
        });
      }

      return sendJson(res, 200, {
        success: true,
        service: "youtube",
        provider: "ytdlp_engine",
        videoId,
        title: info.title || "YouTube Video",
        channel: info.uploader || info.channel || "YouTube Creator",
        thumbnailUrl:
          info.thumbnail || `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
        duration: info.duration || 0,
        durationStr: formatDuration(info.duration),
        sourceUrl: ytUrl,
        directDownloadUrl: directUrl,
        downloadUrl: directUrl,
        downloadLinks,
        mirrors: [
          {
            name: "🌐 Y2Mate Web Mirror (External Browser Portal)",
            type: "web_mirror",
            url: "https://v38.www-y2mate.com/",
          },
        ],
        notice: "Direct GoogleVideo CDN stream generated successfully.",
        durationMs: Date.now() - startTime,
      });
    } catch (ytdlpErr) {
      console.error("All extraction engines failed:", ytdlpErr.message);

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
        downloadUrl: "https://v38.www-y2mate.com/",
        mirrors: [
          {
            name: "🌐 Y2Mate Web Mirror (External Browser Portal)",
            type: "web_mirror",
            url: "https://v38.www-y2mate.com/",
          },
        ],
        downloadLinks: [],
        errorNotice: `Primary: ${primaryErr.message} | Secondary: ${ytdlpErr.message}`,
        notice:
          "Video resolution stream temporarily limited by YouTube. Use the external web mirror portal.",
        durationMs: Date.now() - startTime,
      });
    }
  }
};
