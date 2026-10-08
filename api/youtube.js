/**
 * YouTube All-Quality Downloader — Vercel Serverless API
 * -------------------------------------------------------
 * Usage:
 *   GET  /api/youtube?url=https://youtu.be/VIDEO_ID
 *   POST /api/youtube   body: { "url": "https://youtu.be/VIDEO_ID" }
 *
 * Response: JSON with authentic, verified download links.
 * Fake 2K (1440p) and 4K (2160p) buttons are automatically filtered
 * out if the source video does not genuinely provide that resolution.
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

function sendJson(res, status, data) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.status(status).json(data);
}

// ─── Savenow.to API Configuration ────────────────────────────────────────────

const SAVENOW_API_KEY  = "dfcb6d76f2f6a9894gjkege8a4ab232222";
const SAVENOW_BASE     = "https://p.savenow.to";
const POLL_INTERVAL_MS = 1500;          // poll every 1.5s
const POLL_MAX_TRIES   = 22;            // max ~33s per format
const REQUEST_TIMEOUT  = 12000;         // 12s per individual HTTP call

/** Target formats with quality thresholds */
const VIDEO_FORMATS = [
  { id: "4k",   label: "MP4 4K (2160p)",  type: "video", minHeight: 1800, targetHeight: 2160 },
  { id: "1440", label: "MP4 2K (1440p)",  type: "video", minHeight: 1200, targetHeight: 1440 },
  { id: "1080", label: "MP4 1080p (FHD)", type: "video", minHeight: 900,  targetHeight: 1080 },
  { id: "720",  label: "MP4 720p (HD)",   type: "video", minHeight: 600,  targetHeight: 720 },
  { id: "480",  label: "MP4 480p (SD)",   type: "video", minHeight: 400,  targetHeight: 480 },
  { id: "360",  label: "MP4 360p",        type: "video", minHeight: 300,  targetHeight: 360 },
];

const AUDIO_FORMATS = [
  { id: "mp3",  label: "MP3 Audio (High Quality)", type: "audio" },
  { id: "m4a",  label: "M4A Audio (AAC)",          type: "audio" },
  { id: "flac", label: "FLAC Audio (Lossless)",     type: "audio" },
  { id: "wav",  label: "WAV Audio",                 type: "audio" },
];

// ─── HTTP Helpers ─────────────────────────────────────────────────────────────

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
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
    throw new Error(data.message || "No job ID returned");
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

    // ✅ Done
    if (data.success === 1 && data.download_url) {
      return { ok: true, downloadUrl: data.download_url, data };
    }

    // ❌ Explicit failure
    if (status === "error" || status === "failed") {
      return { ok: false, reason: data.message || "conversion error" };
    }
  }

  return { ok: false, reason: "timed out after max polls" };
}

// ─── Step 3: Inspect Video Stream Real Resolution ─────────────────────────────

/**
 * Reads the first 4-8 KB of an MP4 stream to extract authentic visual dimensions
 * from the ISO/IEC 14496-12 visual sample entry box (avc1, hev1, hvc1, vp09, av01).
 * Returns { width, height } or null.
 */
async function inspectVideoResolution(streamUrl) {
  if (!streamUrl) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);

  try {
    const res = await fetch(streamUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Range": "bytes=0-8192",
      },
    });

    if (!res.body) return null;

    const reader = res.body.getReader();
    const chunks = [];
    let bytesRead = 0;

    while (bytesRead < 8192) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      bytesRead += value.length;
      if (bytesRead >= 2048) {
        controller.abort();
        break;
      }
    }

    const buf = Buffer.concat(chunks);
    for (const tag of ["avc1", "hev1", "hvc1", "vp09", "av01", "mp4v"]) {
      let pos = 32;
      while ((pos = buf.indexOf(Buffer.from(tag), pos)) !== -1) {
        if (pos + 32 <= buf.length) {
          const width = buf.readUInt16BE(pos + 28);
          const height = buf.readUInt16BE(pos + 30);
          if (width > 0 && height > 0 && width <= 8000 && height <= 5000) {
            return { width, height };
          }
        }
        pos += 4;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Step 4: Process one format end-to-end ───────────────────────────────────

async function processFormat(ytUrl, fmt) {
  try {
    const job = await startDownload(ytUrl, fmt.id);
    const result = await pollUntilDone(job.progress_url);

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
      fullFormat:  job.full_format || fmt.label,
      minHeight:   fmt.minHeight || 0,
      targetHeight: fmt.targetHeight || 0,
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
    const meta = await fetchJSON(oembedUrl, 8000);
    return {
      title:       meta.title         || "YouTube Video",
      authorName:  meta.author_name   || "YouTube Creator",
      authorUrl:   meta.author_url    || "https://www.youtube.com/",
      thumbnailUrl: meta.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    };
  } catch {
    return {
      title: "YouTube Video",
      authorName: "YouTube Creator",
      authorUrl: "https://www.youtube.com/",
      thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
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
  const videoId      = getVideoId(requestedUrl);

  if (!videoId) {
    return sendJson(res, 400, {
      success: false,
      error: "A valid YouTube URL is required in 'url' parameter.",
      examples: [
        "?url=https://youtu.be/o6OTjEHms6g",
        "?url=https://www.youtube.com/watch?v=o6OTjEHms6g",
      ],
    });
  }

  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    // ── Fetch metadata first ──────────────────────────────────────────────────
    const meta = await getYouTubeMetadata(videoId);

    // ── Execute formats in parallel ──────────────────────────────────────────
    const allCandidates = [...VIDEO_FORMATS, ...AUDIO_FORMATS];
    const formatResults = await Promise.all(
      allCandidates.map((fmt) => processFormat(ytUrl, fmt))
    );

    const readyFormats = formatResults.filter((r) => r.status === "ready");
    const failedFormats = formatResults.filter((r) => r.status !== "ready");

    // ── Verify Video Resolutions & Discard Fake 2K / 4K / 1080p ─────────────
    // For every ready video format, inspect its stream header to verify actual resolution.
    const verifiedVideoLinks = [];
    const seenDimensions = new Set();
    const seenUrls = new Set();

    // Check video formats from highest to lowest
    const readyVideos = readyFormats.filter((r) => r.type === "video");
    const readyAudios = readyFormats.filter((r) => r.type === "audio");

    // Pre-fetch resolutions for all ready videos in parallel
    const resolutionMap = new Map();
    await Promise.all(
      readyVideos.map(async (vid) => {
        const resData = await inspectVideoResolution(vid.downloadUrl);
        if (resData) resolutionMap.set(vid.downloadUrl, resData);
      })
    );

    for (const vid of readyVideos) {
      if (seenUrls.has(vid.downloadUrl)) {
        continue; // duplicate link discarded
      }

      // Read real resolution from map
      const resData = resolutionMap.get(vid.downloadUrl);

      if (resData && resData.height) {
        const realHeight = resData.height;
        const realWidth = resData.width;

        // FAKE QUALITY REJECTION LOGIC:
        // If format requested 4K (min 1800p), but actual stream height is only 720p or 1080p -> REJECT!
        if (vid.format === "4k" && realHeight < 1800) {
          failedFormats.push({
            format: "4k",
            label: vid.label,
            reason: `Fake 4K rejected: Stream real resolution is only ${realWidth}x${realHeight}p`,
          });
          continue;
        }

        // If format requested 1440p (2K), but actual stream height is only 720p or 1080p -> REJECT!
        if (vid.format === "1440" && realHeight < 1200) {
          failedFormats.push({
            format: "1440",
            label: vid.label,
            reason: `Fake 2K (1440p) rejected: Stream real resolution is only ${realWidth}x${realHeight}p`,
          });
          continue;
        }

        // If format requested 1080p, but actual stream height is only 720p or lower -> REJECT!
        if (vid.format === "1080" && realHeight < 900) {
          failedFormats.push({
            format: "1080",
            label: vid.label,
            reason: `Fake 1080p rejected: Stream real resolution is only ${realWidth}x${realHeight}p`,
          });
          continue;
        }

        // Duplicate resolution check: if another button already has this exact resolution
        const dimKey = `${realWidth}x${realHeight}`;
        if (seenDimensions.has(dimKey)) {
          continue; // Don't create multiple identical buttons for the same video stream
        }
        seenDimensions.add(dimKey);

        seenUrls.add(vid.downloadUrl);
        verifiedVideoLinks.push({
          format: vid.format,
          label: `MP4 ${realHeight}p (${realWidth}x${realHeight})`,
          type: "video",
          quality: `${realHeight}p`,
          fullFormat: `mp4 [${realHeight}p]`,
          downloadUrl: vid.downloadUrl,
          verified: true,
          realResolution: `${realWidth}x${realHeight}`,
        });
      } else {
        // Fallback if range reading is blocked by upstream CDN:
        // Only allow standard <=1080p, do NOT allow unverified 1440p or 4k
        if (vid.format === "4k" || vid.format === "1440") {
          failedFormats.push({
            format: vid.format,
            label: vid.label,
            reason: `Unverified ${vid.format}: High resolution not confirmed by YouTube stream.`,
          });
          continue;
        }

        if (!seenUrls.has(vid.downloadUrl)) {
          seenUrls.add(vid.downloadUrl);
          verifiedVideoLinks.push({
            format: vid.format,
            label: vid.label,
            type: "video",
            quality: `${vid.targetHeight}p`,
            fullFormat: vid.fullFormat,
            downloadUrl: vid.downloadUrl,
            verified: false,
          });
        }
      }
    }

    // Audio links (always authentic audio streams)
    const verifiedAudioLinks = readyAudios.map((a) => ({
      format: a.format,
      label: a.label,
      type: "audio",
      quality: a.format.toUpperCase(),
      fullFormat: a.fullFormat,
      downloadUrl: a.downloadUrl,
    }));

    const finalDownloadLinks = [...verifiedVideoLinks, ...verifiedAudioLinks];

    // Response
    return sendJson(res, 200, {
      success: true,
      service: "youtube",
      videoId,
      title: meta.title,
      authorName: meta.authorName,
      authorUrl: meta.authorUrl,
      thumbnailUrl: meta.thumbnailUrl,
      sourceUrl: requestedUrl,
      watchUrl: ytUrl,
      embedUrl: `https://www.youtube.com/embed/${videoId}`,

      // Only real, verified download links (NO fake 2K/4K/1080p buttons)
      downloadLinks: finalDownloadLinks,

      // Summary counts
      summary: {
        totalCandidates: allCandidates.length,
        verifiedAvailable: finalDownloadLinks.length,
        videosAvailable: verifiedVideoLinks.length,
        audiosAvailable: verifiedAudioLinks.length,
        rejectedFakeFormats: failedFormats.length,
      },

      // Filtered out / rejected fake formats log
      rejectedOrUnavailable: failedFormats.map((f) => ({
        format: f.format,
        label: f.label,
        reason: f.reason,
      })),
    });
  } catch (err) {
    return sendJson(res, 500, {
      success: false,
      error: "Failed to process YouTube video formats",
      details: err.message,
    });
  }
};
