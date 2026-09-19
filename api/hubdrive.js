/**
 * HubDrive Direct Download Link Extractor — Vercel Serverless API
 * -----------------------------------------------------------------
 * Resolves HubDrive / KatDrive links by extracting the embedded HubCloud
 * link and pulling all direct mirrors (R2, Google 10Gbps, HubCDN, etc.).
 *
 * Supports:
 *   - hubdrive.pics, hubdrive.xyz, hubdrive.in, hubdrive.me, katdrive, etc.
 *
 * Usage:
 *   GET  /api/hubdrive?url=https://hubdrive.pics/drive/xxxx
 *   POST /api/hubdrive   body: { "url": "https://hubdrive.pics/drive/xxxx" }
 */

const { extractHubcloudSingle, extractHubcloudPack } = require("./hubcloud.js");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function sendJson(res, status, data) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return res.status(status).json(data);
}

async function extractHubdriveSingle(targetUrl) {
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    Referer: "https://hubdrive.pics/",
  };

  const res = await fetch(targetUrl, { headers, redirect: "follow" });
  const html = await res.text();

  if (res.status !== 200 || !html) {
    throw new Error(`HubDrive: Failed to fetch page content (HTTP ${res.status})`);
  }

  let pageFilename = "";
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) {
    const raw = titleMatch[1].trim();
    if (raw.includes("|")) pageFilename = raw.split("|").pop().trim();
    else if (raw.includes("-")) pageFilename = raw.split("-").pop().trim();
    else pageFilename = raw;
  }

  const hubcloudCandidates = [];
  const aRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = aRegex.exec(html)) !== null) {
    const href = m[1].trim();
    const hrefLower = href.toLowerCase();
    if (hrefLower.includes("t.me") || hrefLower.includes("telegram")) continue;

    if (hrefLower.includes("hubcloud") || hrefLower.includes("hubcdn")) {
      if (!hubcloudCandidates.includes(href)) hubcloudCandidates.push(href);
    }
  }

  if (hubcloudCandidates.length === 0) {
    const rawMatches = html.match(/https?:\/\/[^\s"'<>]*hubcloud[^\s"'<>]+/gi) || [];
    for (const link of rawMatches) {
      if (!link.toLowerCase().includes("t.me") && !hubcloudCandidates.includes(link)) {
        hubcloudCandidates.push(link);
      }
    }
  }

  if (hubcloudCandidates.length === 0) {
    throw new Error("HubDrive: No embedded HubCloud link found on page");
  }

  let lastError = null;
  for (const hcUrl of hubcloudCandidates) {
    try {
      if (hcUrl.includes("/packs/")) {
        const packRes = await extractHubcloudPack(hcUrl);
        packRes.service = "hubdrive";
        if (pageFilename) packRes.title = pageFilename;
        return packRes;
      }

      const result = await extractHubcloudSingle(hcUrl);
      result.service = "hubdrive";
      result.hubcloudUrl = hcUrl;
      if (pageFilename) result.title = pageFilename;
      return result;
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(`HubDrive: Failed to resolve HubCloud link (${lastError?.message || "Unknown error"})`);
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });

  const url = req.method === "GET" ? req.query.url : req.body?.url;
  if (!url) {
    return sendJson(res, 400, { success: false, error: "URL is required" });
  }

  const startTime = Date.now();

  try {
    const result = await extractHubdriveSingle(url);
    result.durationMs = Date.now() - startTime;
    return sendJson(res, 200, result);
  } catch (err) {
    return sendJson(res, 500, {
      success: false,
      service: "hubdrive",
      error: err.message || "Failed to extract HubDrive links",
      durationMs: Date.now() - startTime,
    });
  }
};

module.exports.extractHubdriveSingle = extractHubdriveSingle;
