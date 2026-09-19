/**
 * GDFlix Direct Download Link Extractor — Vercel Serverless API
 * -----------------------------------------------------------------
 * Extracts all Direct Download Links (Google High Speed, Cloudflare R2,
 * Pixeldrain, GoFile, IndexServer) from GDFlix links.
 *
 * Supports:
 *   - gdflix.dev, gdflix.top, gdflix.xyz, gdflix.io, gdflix.pro, etc.
 *   - /file/ and /pack/ links
 *
 * Usage:
 *   GET  /api/gdflix?url=https://gdflix.dev/file/xxxx
 *   POST /api/gdflix   body: { "url": "https://gdflix.dev/file/xxxx" }
 */

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function sendJson(res, status, data) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return res.status(status).json(data);
}

function unwrapFastCdn(urlStr) {
  if (!urlStr) return "";
  let clean = urlStr.replace(/&amp;/g, "&").trim();
  if (clean.includes("url=")) {
    try {
      const u = new URL(clean);
      const target = u.searchParams.get("url");
      if (target && target.startsWith("http")) return decodeURIComponent(target).trim();
    } catch {}
  }
  return clean;
}

async function extractGdflixSingle(targetUrl) {
  const headers = {
    "User-Agent": USER_AGENT,
    Referer: "https://google.com/",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  };

  const res = await fetch(targetUrl, { headers, redirect: "follow" });
  const html = await res.text();

  if (res.status !== 200 || html.length < 200) {
    throw new Error(`GDFlix: Failed to fetch page (HTTP ${res.status})`);
  }

  let fileTitle = "";
  const titleMatch = html.match(/<title>(?:GDFlix\s*\|\s*)?(.*?)<\/title>/i);
  if (titleMatch) {
    fileTitle = titleMatch[1].trim();
  }

  const mirrors = [];

  // 1. Instant Download & Google Direct Link
  let instantUrl = null;
  const instMatch = html.match(/href=["'](https?:\/\/instant\.[^\s"'<>]+)["']/i);
  if (instMatch) {
    instantUrl = instMatch[1].replace(/&amp;/g, "&");
  } else {
    const instMatch2 = html.match(/https?:\/\/instant\.busycdn\.[a-z0-9]+\/[^\s"'<>]+/i);
    if (instMatch2) instantUrl = instMatch2[0].replace(/&amp;/g, "&");
  }

  if (instantUrl) {
    try {
      const instRes = await fetch(instantUrl, {
        headers: { "User-Agent": USER_AGENT, Referer: targetUrl },
        redirect: "manual",
      });

      const locHeader = instRes.headers.get("location");
      let resolvedGoogle = null;
      if (locHeader) {
        resolvedGoogle = unwrapFastCdn(locHeader);
      } else if (instRes.status === 200) {
        resolvedGoogle = unwrapFastCdn(instRes.url || instantUrl);
      }

      if (resolvedGoogle && resolvedGoogle.startsWith("http")) {
        mirrors.push({
          name: "🚀 Google High-Speed Direct Stream",
          type: "google",
          url: resolvedGoogle,
        });
      }
    } catch {}
  }

  // 2. Cloudflare R2 links
  const r2Matches = [
    ...html.matchAll(/href=["'](https?:\/\/[^\s"'<>]*(?:r2\.dev|r2\.cloudflarestorage\.com|pages\.dev\/\?url=[^\s"'<>]+)[^\s"'<>]*)["']/gi),
  ];

  for (const rm of r2Matches) {
    const unwrapped = unwrapFastCdn(rm[1]);
    if (unwrapped && (unwrapped.includes("r2.dev") || unwrapped.includes("r2.cloudflarestorage.com"))) {
      if (!mirrors.some((m) => m.url === unwrapped)) {
        mirrors.push({
          name: "⚡ Cloudflare R2 Direct Stream",
          type: "r2",
          url: unwrapped,
        });
        break;
      }
    }
  }

  // 3. Pixeldrain mirror
  const pixMatch = html.match(/https?:\/\/pixeldrain\.(?:com|dev)\/([^\s"'<>]+)/i);
  if (pixMatch) {
    let pixUrl = pixMatch[0].replace("?embed", "").replace(/&amp;/g, "&");
    const code = pixUrl.split("/u/")[1]?.split(/[\?\/]/)[0] || pixUrl.split("/").pop();
    if (code) {
      const directPix = `https://pixeldrain.com/api/file/${code}?download`;
      mirrors.push({
        name: "📦 Pixeldrain High Speed Mirror",
        type: "pixeldrain",
        url: directPix,
      });
    }
  }

  // 4. GoFile mirror
  const gofileMatch = html.match(/https?:\/\/gofile\.io\/d\/([A-Za-z0-9]+)/i);
  if (gofileMatch) {
    mirrors.push({
      name: "📂 GoFile Direct Mirror",
      type: "gofile",
      url: gofileMatch[0],
    });
  }

  // 5. Direct Server
  const dsMatch = html.match(/href=["'](https?:\/\/[^\s"'<>]*(?:indexserver\.site|workers\.dev)[^\s"'<>]+)["']/i);
  if (dsMatch) {
    const dsUrl = unwrapFastCdn(dsMatch[1]);
    if (dsUrl && !mirrors.some((m) => m.url === dsUrl)) {
      mirrors.push({
        name: "🌐 Direct Worker / IndexServer",
        type: "direct_server",
        url: dsUrl,
      });
    }
  }

  if (mirrors.length === 0) {
    throw new Error("GDFlix: No working direct download mirrors found on page");
  }

  const priority = { google: 0, r2: 1, pixeldrain: 2, gofile: 3, direct_server: 4 };
  mirrors.sort((a, b) => (priority[a.type] ?? 99) - (priority[b.type] ?? 99));

  return {
    success: true,
    service: "gdflix",
    title: fileTitle || "GDFlix File",
    downloadUrl: mirrors[0].url,
    mirrors,
    count: mirrors.length,
  };
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });

  const url = req.method === "GET" ? req.query.url : req.body?.url;
  if (!url) {
    return sendJson(res, 400, { success: false, error: "URL is required" });
  }

  const startTime = Date.now();

  try {
    const result = await extractGdflixSingle(url);
    result.durationMs = Date.now() - startTime;
    return sendJson(res, 200, result);
  } catch (err) {
    return sendJson(res, 500, {
      success: false,
      service: "gdflix",
      error: err.message || "Failed to extract GDFlix links",
      durationMs: Date.now() - startTime,
    });
  }
};

module.exports.extractGdflixSingle = extractGdflixSingle;
