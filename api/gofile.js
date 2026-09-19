/**
 * GoFile Direct Download Link Extractor — Vercel Serverless API
 * -----------------------------------------------------------------
 * Extracts all Direct Download & Stream Links from GoFile (gofile.io / gofile.me)
 * using the Cloudflare Worker bypass API and official GoFile API fallback.
 *
 * Supports:
 *   - gofile.io/d/<contentId>, gofile.me/<contentId>
 *   - Folders with multiple files
 *   - Single direct file links
 *
 * Usage:
 *   GET  /api/gofile?url=https://gofile.io/d/xxxx
 *   POST /api/gofile   body: { "url": "https://gofile.io/d/xxxx" }
 */

const crypto = require("crypto");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function sendJson(res, status, data) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return res.status(status).json(data);
}

function parseContentId(urlStr) {
  try {
    const clean = urlStr.trim().split("::")[0];
    const u = new URL(clean);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length >= 2 && parts[0] === "d") return parts[1];
    return parts[parts.length - 1];
  } catch {
    return urlStr.split("/").pop();
  }
}

// 1. Worker Bypass Method (Ultra Fast)
async function bypassViaWorker(gofileUrl) {
  const apiUrl = `https://gofile.tttjjj.workers.dev/?url=${encodeURIComponent(gofileUrl.trim())}`;
  const res = await fetch(apiUrl, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json, text/plain, */*",
    },
  });

  if (!res.ok) return null;
  const data = await res.json();

  if (data?.status === "success") {
    const title = data.folder_name || data.content_id || "GoFile Content";

    if (Array.isArray(data.files) && data.files.length > 0) {
      const mirrors = data.files
        .map((f) => {
          const streamUrl = f.stream_url || f.download_url;
          if (!streamUrl) return null;
          return {
            name: f.name || "GoFile Item",
            size: f.size_bytes || f.size || 0,
            type: "gofile",
            url: streamUrl,
          };
        })
        .filter(Boolean);

      if (mirrors.length > 0) {
        return {
          success: true,
          service: "gofile",
          title,
          downloadUrl: mirrors[0].url,
          mirrors,
          count: mirrors.length,
        };
      }
    }

    const singleStream = data.file_info?.stream_url || data.file_info?.download_url || data.worker_stream_url;
    if (singleStream) {
      return {
        success: true,
        service: "gofile",
        title: data.file_info?.name || title,
        downloadUrl: singleStream,
        mirrors: [
          {
            name: data.file_info?.name || "GoFile Stream",
            size: data.file_info?.size || 0,
            type: "gofile",
            url: singleStream,
          },
        ],
        count: 1,
      };
    }
  }

  if (data?.error?.includes("notFound")) {
    throw new Error("GoFile: File not found or expired on server");
  }
  if (data?.error?.includes("passwordRequired")) {
    throw new Error("GoFile: This link is password protected");
  }

  return null;
}

// 2. Official GoFile API Fallback
async function bypassViaOfficialApi(contentId, password = "") {
  const accRes = await fetch("https://api.gofile.io/accounts", {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });

  const accData = await accRes.json();
  if (accData.status !== "ok" || !accData.data?.token) {
    throw new Error("GoFile: Failed to obtain session token");
  }

  const token = accData.data.token;
  const timeSlot = Math.floor(Date.now() / 1000 / 14400);
  const rawWt = `${USER_AGENT}::en-US::${token}::${timeSlot}::9844d94d963d30`;
  const wt = crypto.createHash("sha256").update(rawWt).digest("hex");

  let contentUrl = `https://api.gofile.io/contents/${contentId}?cache=true`;
  if (password) {
    const hashedPw = crypto.createHash("sha256").update(password).digest("hex");
    contentUrl += `&password=${hashedPw}`;
  }

  const contRes = await fetch(contentUrl, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "X-Website-Token": wt,
      "X-BL": "en-US",
    },
  });

  const contData = await contRes.json();
  if (contData.status === "error-notFound") {
    throw new Error("GoFile: File not found on GoFile server");
  }
  if (contData.status === "error-passwordRequired") {
    throw new Error("GoFile: Password required for this link");
  }
  if (contData.status !== "ok" || !contData.data) {
    throw new Error(`GoFile: API returned status ${contData.status}`);
  }

  const data = contData.data;
  const title = data.name || contentId;
  const mirrors = [];

  if (data.children) {
    for (const item of Object.values(data.children)) {
      if (item.type === "file" && item.link) {
        mirrors.push({
          name: item.name || "File",
          size: item.size || 0,
          type: "gofile",
          url: item.link,
        });
      }
    }
  }

  if (mirrors.length === 0 && data.link) {
    mirrors.push({
      name: data.name || "File",
      size: data.size || 0,
      type: "gofile",
      url: data.link,
    });
  }

  if (mirrors.length === 0) {
    throw new Error("GoFile: No files found in this link");
  }

  return {
    success: true,
    service: "gofile",
    title,
    downloadUrl: mirrors[0].url,
    mirrors,
    count: mirrors.length,
    accountToken: token,
  };
}

async function extractGofileSingle(targetUrl) {
  let password = "";
  if (targetUrl.includes("::")) {
    const parts = targetUrl.split("::");
    password = parts[parts.length - 1];
    targetUrl = parts.slice(0, -1).join("::");
  }

  const contentId = parseContentId(targetUrl);
  if (!contentId) {
    throw new Error("GoFile: Invalid GoFile URL format");
  }

  try {
    const workerResult = await bypassViaWorker(targetUrl);
    if (workerResult) return workerResult;
  } catch (err) {
    if (err.message.includes("not found") || err.message.includes("password")) {
      throw err;
    }
  }

  return await bypassViaOfficialApi(contentId, password);
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });

  const url = req.method === "GET" ? req.query.url : req.body?.url;
  if (!url) {
    return sendJson(res, 400, { success: false, error: "URL is required" });
  }

  const startTime = Date.now();

  try {
    const result = await extractGofileSingle(url);
    result.durationMs = Date.now() - startTime;
    return sendJson(res, 200, result);
  } catch (err) {
    return sendJson(res, 500, {
      success: false,
      service: "gofile",
      error: err.message || "Failed to extract GoFile link",
      durationMs: Date.now() - startTime,
    });
  }
};

module.exports.extractGofileSingle = extractGofileSingle;
