'use strict';
/**
 * fetch_web_url with lockdown defaults:
 *  - SSRF guard: resolves DNS and refuses loopback / private / link-local / cloud
 *    metadata addresses (config: "allowPrivateFetch": true to disable).
 *  - Size cap: streams the body and aborts past maxBytes (default 5 MB) instead of
 *    buffering the whole response (a 2 GB download used to OOM the bridge).
 *  - Content-type guard: only text-ish responses are decoded; binaries are reported.
 */
const dns = require('dns').promises;
const net = require('net');

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const HARD_MAX_BYTES = 20 * 1024 * 1024;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127) return true;                       // private / loopback
    if (a === 172 && b >= 16 && b <= 31) return true;             // private
    if (a === 192 && b === 168) return true;                      // private
    if (a === 169 && b === 254) return true;                      // link-local (incl. cloud metadata 169.254.169.254)
    if (a === 100 && b >= 64 && b <= 127) return true;            // CGNAT
    if (a === 0) return true;                                     // this-network
    return false;
  }
  const low = ip.toLowerCase();
  if (low === '::1' || low === '::' || low === '::ffff:127.0.0.1') return true;
  if (low.startsWith('fc') || low.startsWith('fd')) return true;  // IPv6 unique-local
  if (low.startsWith('fe80')) return true;                        // IPv6 link-local
  if (low.startsWith('::ffff:')) return isPrivateIp(low.slice(7)); // IPv4-mapped
  return false;
}

async function assertPublicHost(hostname, config) {
  if (config && config.allowPrivateFetch) return;
  // Literal IPs first — no DNS needed.
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error(`Blocked: '${hostname}' is a private/loopback address (SSRF guard, set allowPrivateFetch:true in config.json to override).`);
    return;
  }
  let addrs = [];
  try {
    addrs = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (e) {
    throw new Error(`DNS lookup failed for '${hostname}': ${e.message}`);
  }
  const bad = addrs.find(a => isPrivateIp(a.address));
  if (bad) throw new Error(`Blocked: '${hostname}' resolves to a private/loopback address (${bad.address}) (SSRF guard, set allowPrivateFetch:true in config.json to override).`);
}

async function fetchWebUrl({ url, maxLength = 10000, maxBytes }, config) {
  if (!url || typeof url !== 'string') {
    throw new Error('Valid URL string is required');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (e) {
    throw new Error(`Invalid URL format: ${url}`);
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('Only HTTP and HTTPS protocols are supported');
  }
  if (!parsedUrl.hostname) throw new Error('URL has no hostname');

  // SSRF guard (lockdown default). NOTE: this checks the URL host; a public server
  // could still 302-redirect to a private IP, so redirects are followed manually
  // below with the same check applied per hop.
  await assertPublicHost(parsedUrl.hostname, config);

  const byteCap = Math.min(Math.max(parseInt(maxBytes, 10) || DEFAULT_MAX_BYTES, 1024), HARD_MAX_BYTES);

  let response;
  let currentUrl = parsedUrl;
  for (let hop = 0; hop <= 5; hop++) {
    await assertPublicHost(currentUrl.hostname, config); // re-check every redirect hop
    response = await fetch(currentUrl, {
      signal: AbortSignal.timeout(20000),
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5'
      }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const loc = response.headers.get('location');
      if (!loc) break;
      try { response.body?.cancel(); } catch (e) { /* ignore */ }
      currentUrl = new URL(loc, currentUrl);
      if (!['http:', 'https:'].includes(currentUrl.protocol)) throw new Error(`Redirect to unsupported protocol: ${currentUrl.protocol}`);
      continue;
    }
    break;
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} when fetching ${url}`);
  }

  const contentType = response.headers.get('content-type') || '';
  const declaredLen = parseInt(response.headers.get('content-length') || '0', 10);
  if (declaredLen > byteCap) {
    throw new Error(`Response is ${declaredLen} bytes, over the ${byteCap}-byte cap (pass maxBytes to raise it, max ${HARD_MAX_BYTES}).`);
  }

  // Stream the body with a hard cap.
  let rawBuffer;
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > byteCap) {
        try { await reader.cancel(); } catch (e) { /* ignore */ }
        throw new Error(`Response exceeded the ${byteCap}-byte cap while streaming (pass maxBytes to raise it, max ${HARD_MAX_BYTES}).`);
      }
      chunks.push(Buffer.from(value));
    }
    rawBuffer = Buffer.concat(chunks, received);
  } else {
    rawBuffer = Buffer.from(await response.arrayBuffer());
  }

  const isTextish = /^(text\/|application\/(json|javascript|xml|xhtml|rss|atom))/i.test(contentType) || contentType === '';
  let textContent;
  if (isTextish) {
    textContent = rawBuffer.toString('utf8');
    if (contentType.includes('html')) {
      textContent = textContent
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
    }
  } else {
    textContent = `[binary response: ${contentType || 'unknown type'}, ${rawBuffer.length} bytes — content not decoded]`;
  }

  let truncated = false;
  if (textContent.length > maxLength) {
    textContent = textContent.slice(0, maxLength) + '\n...[Content truncated]';
    truncated = true;
  }

  return {
    url,
    finalUrl: currentUrl.toString(),
    status: response.status,
    contentType,
    bytesReceived: rawBuffer.length,
    contentLength: textContent.length,
    truncated,
    content: textContent
  };
}

module.exports = {
  fetchWebUrl,
  isPrivateIp
};
