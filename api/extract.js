/**
 * Universal Direct Download Link (DDL) Extractor — Vercel Serverless API
 * ------------------------------------------------------------------------
 * All-in-one endpoint that automatically detects the link source
 * and extracts all direct download links (DDL) across:
 *   - HubCloud
 *   - GDFlix
 *   - HubDrive
 *   - MultiCloudLinks
 *   - GoFile
 *   - Pixeldrain
 *   - TeraBox
 *   - DiskWala
 *
 * Usage:
 *   GET  /api/extract?url=ANY_SUPPORTED_LINK
 *   POST /api/extract   body: { "url": "ANY_SUPPORTED_LINK" }
 */

const { extractHubcloudSingle, extractHubcloudPack } = require("./hubcloud.js");
const { extractGdflixSingle } = require("./gdflix.js");
const { extractHubdriveSingle } = require("./hubdrive.js");
const { extractMulticloudSingle } = require("./multicloud.js");
const { extractGofileSingle } = require("./gofile.js");
const { extractVikingfileSingle } = require("./vikingfile.js");

function sendJson(res, status, data) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return res.status(status).json(data);
}

function detectService(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return "unknown";
  const str = urlStr.toLowerCase();

  if (str.includes("hubcloud") || str.includes("hubcdn")) return "hubcloud";
  if (str.includes("gdflix") || str.includes("gd-flix") || str.includes("gdfliix")) return "gdflix";
  if (str.includes("hubdrive") || str.includes("katdrive")) return "hubdrive";
  if (str.includes("multicloudlinks") || str.includes("multidownload.rent")) return "multicloud";
  if (str.includes("gofile.io") || str.includes("gofile.me")) return "gofile";
  if (str.includes("pixeldrain.com") || str.includes("pixeldra.in")) return "pixeldrain";
  if (str.includes("vikingfile.com") || str.includes("vik1ngfile.site") || str.includes("vikingfile")) return "vikingfile";
  if (str.includes("diskwala.com") || str.includes("thediskwala.com")) return "diskwala";
  if (
    str.includes("terabox") ||
    str.includes("1024tera") ||
    str.includes("nephobox") ||
    str.includes("4funbox") ||
    str.includes("mirrobox")
  )
    return "terabox";
  if (str.includes("youtube.com") || str.includes("youtu.be")) return "youtube";

  return "unknown";
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return sendJson(res, 200, { ok: true });

  const url = req.method === "GET" ? req.query.url : req.body?.url;
  const user = req.method === "GET" ? req.query.user || req.query.hash : req.body?.user || req.body?.hash;
  const token = req.method === "GET" ? req.query.token : req.body?.token;
  const cookie = req.method === "GET" ? req.query.cookie : req.body?.cookie;

  if (!url) {
    return sendJson(res, 400, {
      success: false,
      error: "URL parameter is required",
      supportedServices: ["hubcloud", "gdflix", "hubdrive", "multicloud", "gofile", "pixeldrain", "vikingfile"],
    });
  }

  const startTime = Date.now();
  const service = detectService(url);

  try {
    let result;

    switch (service) {
      case "hubcloud":
        if (url.includes("/packs/")) {
          result = await extractHubcloudPack(url);
        } else {
          result = await extractHubcloudSingle(url);
        }
        break;

      case "gdflix":
        result = await extractGdflixSingle(url);
        break;

      case "hubdrive":
        result = await extractHubdriveSingle(url);
        break;

      case "multicloud":
        result = await extractMulticloudSingle(url);
        break;

      case "gofile":
        result = await extractGofileSingle(url);
        break;

      case "vikingfile":
        result = await extractVikingfileSingle(url, { user, token, cookie });
        break;

      case "pixeldrain": {
        const parts = url.split("/u/")[1]?.split(/[\?\/]/)[0] || url.split("/").pop();
        const dl = `https://pixeldrain.com/api/file/${parts}?download`;
        result = {
          success: true,
          service: "pixeldrain",
          title: `Pixeldrain-${parts}`,
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
        break;
      }

      default:
        return sendJson(res, 400, {
          success: false,
          error: `Unsupported service or unrecognized URL: ${url}`,
          detectedService: service,
          supportedServices: ["hubcloud", "gdflix", "hubdrive", "multicloud", "gofile", "pixeldrain", "vikingfile"],
        });
    }

    result.durationMs = Date.now() - startTime;
    return sendJson(res, 200, result);
  } catch (err) {
    return sendJson(res, 500, {
      success: false,
      service,
      error: err.message || "Failed to extract direct download links",
      durationMs: Date.now() - startTime,
    });
  }
};

module.exports.detectService = detectService;
