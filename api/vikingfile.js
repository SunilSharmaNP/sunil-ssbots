/**
 * VikingFile Direct Download Link (DDL) Extractor — Vercel Serverless API
 * ------------------------------------------------------------------------
 * Extracts direct high-speed download links, video stream links, and metadata
 * from vikingfile.com and vik1ngfile.site.
 *
 * Supports free & premium account hash IDs (VIKINGFILE_USER_HASH or passed via user/hash param).
 *
 * Usage:
 *   GET  /api/vikingfile?url=https://vikingfile.com/f/LNrKc3wYiM&user=YOUR_HASH
 *   POST /api/vikingfile   body: { "url": "https://vikingfile.com/f/LNrKc3wYiM", "user": "YOUR_HASH" }
 */

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// =========================================================================
// 🔑 HARDCODED VIKINGFILE USER ACCOUNT HASH ID
// Agar aap URL ya environment variable me hash pass nahi karna chahte,
// toh seedha yahan single quotes ke andar apni Free/Premium Account Hash ID paste karein:
// Example: const HARDCODED_USER_HASH = 'y48bfd92a01ce...';
// =========================================================================
const HARDCODED_USER_HASH = ''; 
// =========================================================================

function formatBytes(bytes, decimals = 2) {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function extractFileId(urlOrId) {
  if (!urlOrId || typeof urlOrId !== 'string') return null;
  const clean = urlOrId.trim();

  // Match /f/XXXXX or /embed/XXXXX or /file/XXXXX or standalone hash
  const m = clean.match(/(?:vikingfile\.com|vik1ngfile\.site)?\/(?:f|embed|file)\/([a-zA-Z0-9_-]+)/i);
  if (m && m[1]) return m[1];

  // If already a standalone alphanumeric hash (e.g. LNrKc3wYiM)
  if (/^[a-zA-Z0-9_-]{6,30}$/.test(clean)) {
    return clean;
  }

  // Fallback match trailing slug
  const trailing = clean.split('?')[0].split('/').filter(Boolean).pop();
  if (trailing && /^[a-zA-Z0-9_-]{6,30}$/.test(trailing)) {
    return trailing;
  }

  return null;
}

/**
 * Checks file status using VikingFile official API
 */
async function checkVikingFile(fileId) {
  try {
    const res = await fetch('https://vikingfile.com/api/check-file', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      body: `hash=${encodeURIComponent(fileId)}`,
      signal: AbortSignal.timeout(6000),
    });

    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        return data[0];
      }
    }
  } catch (err) {
    // Check fallback
  }
  return null;
}

/**
 * Authenticates user hash on VikingFile to obtain authenticated session cookies
 */
async function loginWithUserHash(userHash) {
  if (!userHash) return null;

  try {
    // 1. GET /login to get CSRF token and initial PHPSESSID
    const getRes = await fetch('https://vikingfile.com/login', {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(6000),
    });

    const html = await getRes.text();
    const csrfMatch = html.match(/name=["']_csrf_token["']\s+value=["']([^"']+)["']/i);
    const csrf = csrfMatch ? csrfMatch[1] : '';

    const setCookies = getRes.headers.get('set-cookie') || '';
    const phpSessMatch = setCookies.match(/PHPSESSID=([^;]+)/);
    const phpSessId = phpSessMatch ? phpSessMatch[1] : '';

    if (!csrf) return null;

    // 2. POST /login with user hash
    const postBody = new URLSearchParams({
      hash: userHash.trim(),
      _csrf_token: csrf,
    }).toString();

    const postRes = await fetch('https://vikingfile.com/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
        Cookie: phpSessId ? `PHPSESSID=${phpSessId}` : '',
        Referer: 'https://vikingfile.com/login',
        Origin: 'https://vikingfile.com',
      },
      body: postBody,
      redirect: 'manual',
      signal: AbortSignal.timeout(6000),
    });

    const postSetCookies = postRes.headers.get('set-cookie') || '';
    const rememberMatch = postSetCookies.match(/REMEMBERME=([^;]+)/);
    const updatedPhpSessMatch = postSetCookies.match(/PHPSESSID=([^;]+)/);

    const activePhpSess = updatedPhpSessMatch ? updatedPhpSessMatch[1] : phpSessId;
    const rememberMe = rememberMatch ? rememberMatch[1] : '';

    const cookieParts = [];
    if (activePhpSess) cookieParts.push(`PHPSESSID=${activePhpSess}`);
    if (rememberMe) cookieParts.push(`REMEMBERME=${rememberMe}`);

    return cookieParts.join('; ');
  } catch (err) {
    return null;
  }
}

/**
 * Attempts to request direct download URL from vik1ngfile.site
 */
async function requestDownloadEndpoint(fileId, cookieHeader = '', turnstileToken = '', userHash = '') {
  const targetEndpoints = [
    `https://vik1ngfile.site/f/${fileId}`,
    `https://vikingfile.com/f/${fileId}`,
  ];

  for (const endpoint of targetEndpoints) {
    try {
      const headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'User-Agent': USER_AGENT,
        Referer: endpoint,
        Origin: endpoint.startsWith('https://vik1ngfile.site') ? 'https://vik1ngfile.site' : 'https://vikingfile.com',
      };

      if (cookieHeader) {
        headers['Cookie'] = cookieHeader;
      }

      const params = new URLSearchParams();
      if (turnstileToken) {
        params.append('cf-turnstile-response', turnstileToken);
      } else {
        params.append('cf-turnstile-response', '');
      }

      if (userHash) {
        params.append('user', userHash.trim());
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: params.toString(),
        signal: AbortSignal.timeout(5000),
      });

      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const json = await res.json();
        if (json && (json.link || json.files)) {
          return json;
        }
      }
    } catch (e) {
      // Continue to next endpoint
    }
  }

  return null;
}

/**
 * Primary VikingFile Extractor Function
 */
async function extractVikingfileSingle(targetUrl, options = {}) {
  const fileId = extractFileId(targetUrl);
  if (!fileId) {
    throw new Error(`Invalid VikingFile URL or file hash: ${targetUrl}`);
  }

  const userHash =
    options.user ||
    options.hash ||
    HARDCODED_USER_HASH ||
    process.env.VIKINGFILE_USER_HASH ||
    process.env.VIKINGFILE_HASH ||
    process.env.VIKINGFILE_USER ||
    '';

  const turnstileToken = options.token || options.turnstile || options['cf-turnstile-response'] || '';
  const providedCookie = options.cookie || options.session || '';

  // 1. Fetch official file metadata
  const checkInfo = await checkVikingFile(fileId);
  const exists = checkInfo ? checkInfo.exist !== false : true;
  if (checkInfo && checkInfo.exist === false) {
    throw new Error(`VikingFile: File not found or removed (Hash: ${fileId})`);
  }

  const fileName = checkInfo?.name || `vikingfile-${fileId}`;
  const fileSize = checkInfo?.size || 0;
  const formattedSize = fileSize ? formatBytes(fileSize) : '';

  // 2. Resolve authentication cookies if user hash or custom cookie is provided
  let authCookies = providedCookie;
  if (!authCookies && userHash) {
    const loggedInCookies = await loginWithUserHash(userHash);
    if (loggedInCookies) {
      authCookies = loggedInCookies;
    }
  }

  // 3. Attempt direct download generation from backend
  const downloadData = await requestDownloadEndpoint(fileId, authCookies, turnstileToken, userHash);

  const directLink = downloadData?.link || '';
  const mirrors = [];

  if (directLink) {
    mirrors.push({
      name: '⚡ VikingFile Direct High-Speed Download',
      type: 'vikingfile_direct',
      url: directLink,
      size: fileSize || undefined,
    });
  }

  // If archive contains individual files
  if (downloadData?.files && Array.isArray(downloadData.files)) {
    const archiveBase = downloadData.linkArchive || directLink;
    for (const file of downloadData.files) {
      mirrors.push({
        name: `📁 ${file.name} (${formatBytes(file.size)})`,
        type: 'vikingfile_archive_file',
        url: archiveBase ? `${archiveBase}${file.name}` : '',
        size: file.size,
      });
    }
  }

  // Embed & preview links
  const embedUrl = `https://vikingfile.com/f/${fileId}`;
  const fastDownloadUrl = `https://vik1ngfile.site/fast-download/${encodeURIComponent(fileName)}%20%5B${encodeURIComponent(formattedSize)}%5D`;

  if (!directLink) {
    // If turnstile captcha prevented instant server-side bypass without active session
    mirrors.push({
      name: '🌐 VikingFile File Page (Ready for Direct Download)',
      type: 'vikingfile_page',
      url: embedUrl,
      size: fileSize || undefined,
    });
  }

  return {
    success: true,
    service: 'vikingfile',
    title: fileName,
    fileId,
    size: fileSize,
    sizeFormatted: formattedSize,
    downloadUrl: directLink || embedUrl,
    directLinkAvailable: Boolean(directLink),
    userHashConfigured: Boolean(userHash),
    accountType: userHash ? 'User Account Hash Attached' : 'Anonymous / Public',
    mirrors,
    count: mirrors.length,
    captchaSiteKey: '0x4AAAAAAAgbsMNBuk2d3Qp6',
    notes: directLink
      ? 'Direct download link successfully generated!'
      : 'VikingFile file verified. If Turnstile captcha is active for free accounts, provide token or user account hash in options.',
  };
}

function sendJson(res, status, data) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return res.status(status).json(data);
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });

  const url = req.method === 'GET' ? req.query.url : req.body?.url;
  const user = req.method === 'GET' ? req.query.user || req.query.hash : req.body?.user || req.body?.hash;
  const token = req.method === 'GET' ? req.query.token : req.body?.token;
  const cookie = req.method === 'GET' ? req.query.cookie : req.body?.cookie;

  if (!url) {
    return sendJson(res, 400, {
      success: false,
      error: 'URL parameter is required (e.g., https://vikingfile.com/f/LNrKc3wYiM)',
      options: {
        url: 'VikingFile URL (required)',
        user: 'User Account Hash ID (optional)',
        token: 'Cloudflare Turnstile token (optional)',
        cookie: 'Browser session cookie (optional)',
      },
    });
  }

  const startTime = Date.now();
  try {
    const result = await extractVikingfileSingle(url, { user, token, cookie });
    result.durationMs = Date.now() - startTime;
    return sendJson(res, 200, result);
  } catch (err) {
    return sendJson(res, 500, {
      success: false,
      service: 'vikingfile',
      error: err.message || 'VikingFile extraction failed',
      durationMs: Date.now() - startTime,
    });
  }
};

module.exports.extractVikingfileSingle = extractVikingfileSingle;
module.exports.extractFileId = extractFileId;
module.exports.checkVikingFile = checkVikingFile;
