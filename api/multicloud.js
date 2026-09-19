/**
 * MultiCloudLinks Direct Download Link Extractor — Vercel Serverless API
 * ------------------------------------------------------------------------
 * Extracts direct Turbo Download (R2 / multidownload.rent), Pixeldrain,
 * GDFlix, FilePress, and other high-speed mirrors from MultiCloudLinks.
 *
 * Supports:
 *   - multicloudlinks.com, new.multicloudlinks.com, new2.multicloudlinks.com, multidownload.rent
 *
 * Usage:
 *   GET  /api/multicloud?url=https://new2.multicloudlinks.com/xxxx
 *   POST /api/multicloud   body: { "url": "https://new2.multicloudlinks.com/xxxx" }
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

async function extractMulticloudSingle(targetUrl) {
  if (targetUrl.includes("multidownload.rent")) {
    return {
      success: true,
      service: "multicloud",
      title: targetUrl.split("/").pop() || "Direct File",
      downloadUrl: targetUrl,
      mirrors: [
        {
          name: "⚡ Turbo R2 Direct Download (multidownload.rent)",
          type: "turbo",
          url: targetUrl,
        },
      ],
      count: 1,
    };
  }

  if (targetUrl.includes("pixeldra.") || (targetUrl.includes("multicloudlinks.com") && targetUrl.includes("pid="))) {
    try {
      const res = await fetch(targetUrl, {
        headers: { "User-Agent": USER_AGENT },
        redirect: "follow",
      });
      const finalUrl = res.url;
      if (finalUrl.includes("pixeldrain.com/u/")) {
        const pid = finalUrl.split("/u/")[1]?.split(/[\?\/]/)[0];
        const dl = `https://pixeldrain.com/api/file/${pid}?download`;
        return {
          success: true,
          service: "multicloud",
          title: `Pixeldrain-${pid}`,
          downloadUrl: dl,
          mirrors: [
            {
              name: "📦 Pixeldrain API Direct Download",
              type: "pixeldrain",
              url: dl,
            },
          ],
          count: 1,
        };
      }
    } catch {}
  }

  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    Referer: "https://new2.multicloudlinks.com/",
  };

  const res = await fetch(targetUrl, { headers, redirect: "follow" });
  const html = await res.text();

  if (res.status !== 200 || !html) {
    throw new Error(`MultiCloud: Failed to fetch page content (HTTP ${res.status})`);
  }

  let pageFilename = "";
  const fnMatch1 = html.match(/class=["'][^"']*file-icon-name[^"']*["'][^>]*title=["']([^"']+)["']/i);
  if (fnMatch1) pageFilename = fnMatch1[1].trim();

  if (!pageFilename) {
    const fnMatch2 = html.match(/class=["'][^"']*file-icon-name[^"']*["'][^>]*>(.*?)<\/div>/is);
    if (fnMatch2) {
      const clean = fnMatch2[1].replace(/<[^>]+>/g, "").trim();
      if (clean && !clean.toLowerCase().includes("download")) pageFilename = clean;
    }
  }

  if (!pageFilename) {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch) {
      const p = titleMatch[1].split(" - ")[0].trim();
      if (p && !p.toLowerCase().includes("multicloud")) pageFilename = p;
    }
  }

  const mirrors = [];
  const aRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;

  while ((m = aRegex.exec(html)) !== null) {
    let href = m[1].replace(/&amp;/g, "&").trim();
    const rawText = m[2].replace(/<[^>]+>/g, "").trim();
    const hrefLower = href.toLowerCase();
    const txtLower = rawText.toLowerCase();

    if (
      !href ||
      href.startsWith("#") ||
      href.startsWith("javascript:") ||
      hrefLower.includes("login") ||
      hrefLower.includes("signup") ||
      hrefLower.includes("t.me") ||
      hrefLower.includes("telegram")
    ) {
      continue;
    }

    if (!href.startsWith("http")) {
      try {
        href = new URL(href, targetUrl).toString();
      } catch {
        continue;
      }
    }

    if (hrefLower.includes("multidownload.rent") || txtLower.includes("turbo") || (txtLower.includes("r2") && txtLower.includes("download"))) {
      if (!mirrors.some((item) => item.url === href)) {
        mirrors.push({
          name: "⚡ Turbo R2 Direct Download",
          type: "turbo",
          url: href,
        });
      }
    } else if (hrefLower.includes("pixeldra") || txtLower.includes("pixeldrain")) {
      let pixUrl = href;
      if (pixUrl.includes("pixeldrain.com/u/")) {
        const code = pixUrl.split("/u/")[1]?.split(/[\?\/]/)[0];
        if (code) pixUrl = `https://pixeldrain.com/api/file/${code}?download`;
      }
      if (!mirrors.some((item) => item.url === pixUrl)) {
        mirrors.push({
          name: "📦 Pixeldrain Mirror",
          type: "pixeldrain",
          url: pixUrl,
        });
      }
    } else if (hrefLower.includes("gdflix") || txtLower.includes("gdflix")) {
      if (!mirrors.some((item) => item.url === href)) {
        mirrors.push({
          name: "🎬 GDFlix Mirror",
          type: "gdflix",
          url: href,
        });
      }
    } else if (hrefLower.includes("filepress") || hrefLower.includes("filebee")) {
      if (!mirrors.some((item) => item.url === href)) {
        mirrors.push({
          name: "🐝 FilePress / FileBee Mirror",
          type: "filepress",
          url: href,
        });
      }
    } else if (hrefLower.includes("/dl/") || txtLower.includes("download")) {
      if (!mirrors.some((item) => item.url === href)) {
        mirrors.push({
          name: rawText || "📥 Direct Download Link",
          type: "direct",
          url: href,
        });
      }
    }
  }

  if (!mirrors.some((m) => m.type === "turbo")) {
    const turboMatches = html.match(/https?:\/\/[^\s"'<>]*multidownload\.rent[^\s"'<>]+/gi) || [];
    for (const tu of turboMatches) {
      const cleanTu = tu.replace(/&amp;/g, "&").trim();
      if (!mirrors.some((m) => m.url === cleanTu)) {
        mirrors.unshift({
          name: "⚡ Turbo R2 Direct Download",
          type: "turbo",
          url: cleanTu,
        });
      }
    }
  }

  if (mirrors.length === 0) {
    throw new Error("MultiCloud: No working download mirrors found on page");
  }

  const priority = { turbo: 0, pixeldrain: 1, gdflix: 2, filepress: 3, direct: 4 };
  mirrors.sort((a, b) => (priority[a.type] ?? 99) - (priority[b.type] ?? 99));

  return {
    success: true,
    service: "multicloud",
    title: pageFilename || "MultiCloud File",
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
    const result = await extractMulticloudSingle(url);
    result.durationMs = Date.now() - startTime;
    return sendJson(res, 200, result);
  } catch (err) {
    return sendJson(res, 500, {
      success: false,
      service: "multicloud",
      error: err.message || "Failed to extract MultiCloud links",
      durationMs: Date.now() - startTime,
    });
  }
};

module.exports.extractMulticloudSingle = extractMulticloudSingle;
