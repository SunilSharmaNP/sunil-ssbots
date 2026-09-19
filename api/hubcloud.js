/**
 * HubCloud Direct Download Link Extractor — Vercel Serverless API
 * -----------------------------------------------------------------
 * Extracts all Direct Download Links (FSL, Cloudflare R2, Google 10Gbps,
 * HubCDN, Pixeldrain, Direct Server) from HubCloud links.
 *
 * Supports:
 *   - hubcloud.one, hubcloud.club, hubcloud.lat, hubcloud.ninja, etc.
 *   - /drive/ and /packs/ links
 *
 * Usage:
 *   GET  /api/hubcloud?url=https://hubcloud.one/drive/xxxx
 *   POST /api/hubcloud   body: { "url": "https://hubcloud.one/drive/xxxx" }
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

function detectHubcloudBase(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.hostname.includes("hubcloud.")) {
      return `https://${u.hostname}`;
    }
  } catch {}
  return "https://hubcloud.one";
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

async function extractHubcloudSingle(targetUrl) {
  const base = detectHubcloudBase(targetUrl);
  let pageUrl = targetUrl;
  try {
    const u = new URL(targetUrl);
    pageUrl = `${base}${u.pathname}${u.search}`;
  } catch {}

  const headers = {
    "User-Agent": USER_AGENT,
    Referer: base,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  };

  // Step 1: Initial page fetch
  const res1 = await fetch(pageUrl, { headers, redirect: "follow" });
  const html1 = await res1.text();

  let intermediateUrl = "";

  const scriptMatch = html1.match(/var\s+url\s*=\s*['"]([^'"]+)['"]/);
  if (scriptMatch) {
    intermediateUrl = scriptMatch[1];
  }

  if (!intermediateUrl) {
    const aMatch = html1.match(/<div[^>]*class=["'][^"']*vd[^"']*["'][^>]*>[\s\S]*?<a[^>]*href=["']([^"']+)["']/i);
    if (aMatch) intermediateUrl = aMatch[1];
  }

  if (!intermediateUrl) {
    const redirMatch = html1.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/i);
    if (redirMatch) intermediateUrl = redirMatch[1];
  }

  if (!intermediateUrl) {
    if (html1.includes("card-body") || html1.includes("btn-success") || html1.includes("btn-primary")) {
      intermediateUrl = pageUrl;
    } else {
      throw new Error("HubCloud: Could not find intermediate download step");
    }
  }

  if (!intermediateUrl.startsWith("http")) {
    intermediateUrl = new URL(intermediateUrl, base).toString();
  }

  // Step 2: Intermediate download page
  let html2 = html1;
  let finalPageUrl = intermediateUrl;
  if (intermediateUrl !== pageUrl) {
    const res2 = await fetch(intermediateUrl, {
      headers: { ...headers, Referer: pageUrl },
      redirect: "follow",
    });
    html2 = await res2.text();
    finalPageUrl = res2.url || intermediateUrl;
  }

  const pxlMatch = html2.match(/var\s+pxl\s*=\s*["']([^"']+)["']/);
  const pxlUrl = pxlMatch ? pxlMatch[1] : null;

  let fileTitle = "";
  const titleMatch = html2.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) {
    let t = titleMatch[1].replace(/HubCloud\s*\|\s*/i, "").replace(/Download\s*\|\s*/i, "").trim();
    if (t) fileTitle = t;
  }

  const linkRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const mirrors = [];
  let m;

  while ((m = linkRegex.exec(html2)) !== null) {
    let href = m[1].trim();
    const rawText = m[2].replace(/<[^>]+>/g, "").trim();
    const tagStr = m[0].toLowerCase();
    const txtLower = rawText.toLowerCase();

    if (!href || href.startsWith("#") || href.startsWith("javascript:")) continue;

    const hrefLower = href.toLowerCase();
    if (
      hrefLower.includes("t.me") ||
      hrefLower.includes("telegram") ||
      hrefLower.includes("tinyurl.com") ||
      hrefLower.includes("snvhost.com") ||
      hrefLower.includes("facebook.com") ||
      hrefLower.includes("twitter.com") ||
      hrefLower.includes("/login") ||
      hrefLower.includes("/sign")
    ) {
      continue;
    }

    if (tagStr.includes('id="pxl-1"') && pxlUrl) {
      href = pxlUrl;
    }

    if (!href.startsWith("http")) {
      try {
        href = new URL(href, finalPageUrl).toString();
      } catch {
        continue;
      }
    }

    let type = "direct";
    let name = "Direct Download";

    if (txtLower.includes("fsl") || hrefLower.includes("r2.cloudflarestorage.com") || hrefLower.includes("s3")) {
      type = "fsl";
      name = "⚡ Cloudflare R2 / FSL (High Speed)";
    } else if (
      txtLower.includes("google") ||
      txtLower.includes("10gbps") ||
      hrefLower.includes("gpdl.") ||
      hrefLower.includes("googleusercontent.com")
    ) {
      type = "google";
      name = "🚀 Google High-Speed (10Gbps)";
    } else if (txtLower.includes("cdn") || hrefLower.includes("hubcdn")) {
      type = "cdn";
      name = "🌐 HubCDN Direct Mirror";
    } else if (hrefLower.includes("pixeldrain") || txtLower.includes("pixel")) {
      type = "pixel";
      name = "📦 Pixeldrain Mirror";
    } else if (
      hrefLower.includes("download") ||
      hrefLower.includes("drive") ||
      hrefLower.includes("get_file") ||
      hrefLower.includes("dl.php")
    ) {
      type = "direct";
      name = rawText || "📥 Server Direct Link";
    } else {
      continue;
    }

    if (href.includes("pixeldrain.com/u/")) {
      const parts = href.split("/u/")[1]?.split(/[\?\/]/)[0];
      if (parts) {
        href = `https://pixeldrain.com/api/file/${parts}?download`;
      }
    }

    if (href.includes("dl.php?link=") || href.includes("gpdl.")) {
      try {
        const uParsed = new URL(href);
        const lParam = uParsed.searchParams.get("link");
        if (lParam && lParam.startsWith("http")) {
          href = lParam;
        }
      } catch {}
    }

    href = unwrapFastCdn(href);

    if (!mirrors.some((item) => item.url === href)) {
      mirrors.push({ name, type, url: href, text: rawText });
    }
  }

  if (mirrors.length === 0) {
    throw new Error("HubCloud: No working download mirrors found on page");
  }

  const priority = { fsl: 0, google: 1, cdn: 2, pixel: 3, direct: 4 };
  mirrors.sort((a, b) => (priority[a.type] ?? 99) - (priority[b.type] ?? 99));

  return {
    success: true,
    service: "hubcloud",
    title: fileTitle || "HubCloud File",
    downloadUrl: mirrors[0].url,
    mirrors,
    count: mirrors.length,
  };
}

async function extractHubcloudPack(packUrl) {
  const headers = { "User-Agent": USER_AGENT };
  const res = await fetch(packUrl, { headers });
  const text = await res.text();

  const match = text.match(/JSON\.parse\(`([\s\S]+?)`\)/);
  if (!match) {
    throw new Error("HubCloud: Could not parse pack JSON list");
  }

  const data = JSON.parse(match[1]);
  const base = detectHubcloudBase(packUrl);
  const files = data.files || [];

  const fileLinks = files.map((f) => ({
    name: f.name || f.file_name,
    size: f.size,
    url: `${base}/drive/${f.share_id}`,
  }));

  return {
    success: true,
    service: "hubcloud_pack",
    totalFiles: fileLinks.length,
    files: fileLinks,
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
    if (url.includes("/packs/")) {
      const packResult = await extractHubcloudPack(url);
      packResult.durationMs = Date.now() - startTime;
      return sendJson(res, 200, packResult);
    }

    const result = await extractHubcloudSingle(url);
    result.durationMs = Date.now() - startTime;
    return sendJson(res, 200, result);
  } catch (err) {
    return sendJson(res, 500, {
      success: false,
      service: "hubcloud",
      error: err.message || "Failed to extract HubCloud links",
      durationMs: Date.now() - startTime,
    });
  }
};

module.exports.extractHubcloudSingle = extractHubcloudSingle;
module.exports.extractHubcloudPack = extractHubcloudPack;
