// In-TV web proxy for JARVIS.
// It removes upstream frame-blocking headers and rewrites common HTML/CSS
// resource links back through this proxy so the page can render in the TV iframe.

const BLOCKED_HOSTS = new Set([
  'localhost', '127.0.0.1', '0.0.0.0', '::1',
  '169.254.169.254', 'metadata.google.internal'
]);

function isPrivateIPv4(host) {
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  return a === 10 || a === 127 || a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168);
}

function validateTarget(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Invalid website URL.'); }
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw new Error('Only HTTP and HTTPS websites are supported.');
  }
  const host = u.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host) || isPrivateIPv4(host) || host.endsWith('.localhost')) {
    throw new Error('Private/local addresses are not allowed.');
  }
  return u;
}

function proxify(abs, baseUrl) {
  try {
    const u = new URL(abs, baseUrl);
    if (!['http:', 'https:'].includes(u.protocol)) return abs;
    return '/api/proxy?url=' + encodeURIComponent(u.href);
  } catch {
    return abs;
  }
}

function rewriteSrcset(value, baseUrl) {
  return value.split(',').map(part => {
    const bits = part.trim().split(/\s+/);
    if (!bits[0]) return part;
    bits[0] = proxify(bits[0], baseUrl);
    return bits.join(' ');
  }).join(', ');
}

function rewriteHtml(html, baseUrl) {
  // Common URL-bearing attributes.
  html = html.replace(/(\s(?:src|href|action|poster|data-src|data-href)\s*=\s*)(["'])(.*?)\2/gi,
    (all, prefix, quote, value) => {
      const v = value.trim();
      if (!v || v.startsWith('#') || /^(?:data:|blob:|javascript:|mailto:|tel:)/i.test(v)) return all;
      return prefix + quote + proxify(v, baseUrl) + quote;
    });

  html = html.replace(/(\s(?:srcset|data-srcset)\s*=\s*)(["'])(.*?)\2/gi,
    (all, prefix, quote, value) => prefix + quote + rewriteSrcset(value, baseUrl) + quote);

  // Inline CSS url(...) values.
  html = html.replace(/url\(\s*(["']?)([^)"']+)\1\s*\)/gi,
    (all, quote, value) => {
      if (/^(?:data:|blob:|#)/i.test(value.trim())) return all;
      return `url("${proxify(value.trim(), baseUrl)}")`;
    });

  // Basic meta refresh support.
  html = html.replace(/(<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]+content\s*=\s*["'][^"']*url=)([^"']+)/gi,
    (all, prefix, value) => prefix + proxify(value.trim(), baseUrl));

  // Keep relative JS/CSS references that escaped the attribute rewrite working.
  const marker = `<script>window.__JARVIS_PROXY_ORIGIN__=${JSON.stringify(baseUrl)};</script>`;
  return html.replace(/<head([^>]*)>/i, `<head$1>${marker}`);
}

function rewriteCss(css, baseUrl) {
  return css.replace(/url\(\s*(["']?)([^)"']+)\1\s*\)/gi,
    (all, quote, value) => {
      if (/^(?:data:|blob:|#)/i.test(value.trim())) return all;
      return `url("${proxify(value.trim(), baseUrl)}")`;
    });
}

module.exports = async function handler(req, res) {
  const raw = req.query?.url;
  if (!raw) return res.status(400).send('Missing ?url= parameter.');

  let target;
  try {
    target = validateTarget(raw);
  } catch (e) {
    return res.status(400).send(e.message);
  }

  try {
    const upstream = await fetch(target.href, {
      redirect: 'follow',
      headers: {
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (JARVIS Web Proxy)',
        'Accept': req.headers.accept || '*/*',
        'Accept-Language': req.headers['accept-language'] || 'en-IN,en;q=0.9',
        ...(req.headers.cookie ? { Cookie: req.headers.cookie } : {})
      }
    });

    const finalUrl = upstream.url || target.href;
    const type = upstream.headers.get('content-type') || 'application/octet-stream';
    const isHtml = /text\/html|application\/xhtml\+xml/i.test(type);
    const isCss = /text\/css/i.test(type);

    // Forward cookies to the proxy origin, stripping upstream Domain so the
    // browser can store them for the JARVIS proxy instead of the target host.
    if (typeof upstream.headers.getSetCookie === 'function') {
      const cookies = upstream.headers.getSetCookie();
      if (cookies.length) {
        res.setHeader('Set-Cookie', cookies.map(c => c.replace(/;\s*Domain=[^;]+/ig, '')));
      }
    }

    res.status(upstream.status);
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    // Deliberately do not forward upstream CSP/frame headers that would stop
    // this proxied document from being rendered in the JARVIS iframe.

    if (isHtml || isCss) {
      const text = await upstream.text();
      const output = isHtml ? rewriteHtml(text, finalUrl) : rewriteCss(text, finalUrl);
      return res.send(output);
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    return res.send(buffer);
  } catch (e) {
    console.error('JARVIS proxy error:', e);
    return res.status(502).send(`Unable to load website: ${e.message}`);
  }
};
