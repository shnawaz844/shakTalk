/**
 * Public website served on the same domain as the API (www.shaktalk.com):
 *   /                 landing page          (public/index.html)
 *   /privacy          privacy policy        (public/privacy.html)
 *   /terms            terms of use          (public/terms.html)
 *   /support          help + contact        (public/support.html)
 *   /delete-account   account deletion      (public/delete-account.html; Google Play needs this URL)
 *   /.well-known/apple-app-site-association   iOS universal links (join links open the app)
 *   /.well-known/assetlinks.json              Android app links  (join links open the app)
 *   static files: site.css, logo.png, og.png, favicon.png, apple-touch-icon.png
 *
 * Pages are plain HTML with {{TOKENS}}, filled in once at start-up from the
 * settings below (all can be overridden with environment variables).
 * Fill in the company details before launch.
 */

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, 'public');
const IOS_BUNDLE_ID = 'com.cis.shaktranslate';
const ANDROID_PACKAGE = 'com.cis.shaktranslate';

const SITE = {
  SITE_URL: process.env.SITE_URL || 'https://www.shaktalk.com',
  SUPPORT_EMAIL: process.env.SUPPORT_EMAIL || 'support@shaktalk.com',
  COMPANY_NAME: process.env.COMPANY_NAME || 'ShakTalk',
  COMPANY_ADDRESS: process.env.COMPANY_ADDRESS || '[registered address]',
  GRIEVANCE_OFFICER: process.env.GRIEVANCE_OFFICER || '[name of grievance officer]',
  GOVERNING_LAW: process.env.GOVERNING_LAW || 'India',
  POLICY_DATE: process.env.POLICY_DATE || '1 November 2026',
  // Store links. The App Store link is known only after Apple approves the
  // app: until APP_STORE_URL is set, the button shows "Coming soon".
  PLAY_STORE_URL: process.env.PLAY_STORE_URL || `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}`,
  APP_STORE_URL: process.env.APP_STORE_URL || '',
};
// App links: Apple Team ID (developer.apple.com → Membership) and the SHA-256
// fingerprint(s) of the Android signing key (Play Console → App integrity →
// App signing). Comma-separate several fingerprints.
const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID || '';
const ANDROID_SHA256 = (process.env.ANDROID_SHA256_FINGERPRINTS || '').split(',').map((s) => s.trim()).filter(Boolean);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const APPLE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.37 12.6c-.02-2.27 1.86-3.36 1.94-3.41-1.06-1.55-2.7-1.76-3.28-1.78-1.4-.14-2.73.82-3.44.82-.71 0-1.8-.8-2.96-.78-1.52.02-2.93.89-3.71 2.25-1.59 2.75-.41 6.81 1.13 9.04.76 1.09 1.65 2.31 2.82 2.27 1.14-.05 1.57-.73 2.94-.73 1.37 0 1.76.73 2.96.71 1.22-.02 1.99-1.11 2.73-2.21.87-1.27 1.22-2.5 1.24-2.56-.03-.01-2.38-.91-2.4-3.62zM14.12 5.94c.62-.76 1.05-1.8.93-2.85-.9.04-2 .6-2.64 1.35-.57.66-1.08 1.73-.94 2.75 1 .08 2.02-.51 2.65-1.25z"/></svg>';
const PLAY_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#00D7FE" d="M3.6 2.3c-.3.3-.4.7-.4 1.2v17c0 .5.1.9.4 1.2l9.5-9.7z"/><path fill="#FFCE00" d="M16.3 15.2 13.1 12l3.2-3.2 3.8 2.2c1.1.6 1.1 1.6 0 2.2z"/><path fill="#FF3A44" d="M16.3 15.2 13.1 12l-9.5 9.7c.4.4 1 .4 1.7 0z"/><path fill="#00F076" d="M16.3 8.8 5.3 2.3c-.7-.4-1.3-.4-1.7 0l9.5 9.7z"/></svg>';

function storeButtons() {
  const play = `<a class="store-btn" href="${esc(SITE.PLAY_STORE_URL)}" rel="noopener">${PLAY_SVG}<span><small>Get it on</small><strong>Google Play</strong></span></a>`;
  const apple = SITE.APP_STORE_URL
    ? `<a class="store-btn" href="${esc(SITE.APP_STORE_URL)}" rel="noopener">${APPLE_SVG}<span><small>Download on the</small><strong>App Store</strong></span></a>`
    : `<span class="store-btn soon" aria-disabled="true">${APPLE_SVG}<span><small>App Store</small><strong>Coming soon</strong></span></span>`;
  return `<div class="store-row">${apple}${play}</div>`;
}

const HEAD = `  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0A0D0C">
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="ShakTalk">
  <meta property="og:image" content="${esc(SITE.SITE_URL)}/og.png">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/site.css">`;

const HEADER = `<header class="site-header">
  <div class="wrap">
    <a class="brand" href="/"><img src="/logo.png" alt="" width="36" height="36"><span>Shak<b>Talk</b></span></a>
    <nav class="nav" aria-label="Main">
      <a href="/#how">How it works</a>
      <a href="/#languages">Languages</a>
      <a href="/#faq">FAQ</a>
      <a href="/support">Support</a>
      <a class="btn btn-primary" href="/#get">Get the app</a>
    </nav>
  </div>
</header>`;

const FOOTER = `<footer class="site-footer">
  <div class="wrap">
    <div>© ${new Date().getFullYear()} ${esc(SITE.COMPANY_NAME)}. All rights reserved.</div>
    <nav aria-label="Footer">
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms</a>
      <a href="/support">Support</a>
      <a href="/delete-account">Delete account</a>
      <a href="mailto:${esc(SITE.SUPPORT_EMAIL)}">${esc(SITE.SUPPORT_EMAIL)}</a>
    </nav>
  </div>
</footer>`;

function render(html) {
  return html
    .replace(/\{\{HEAD\}\}/g, HEAD)
    .replace(/\{\{HEADER\}\}/g, HEADER)
    .replace(/\{\{FOOTER\}\}/g, FOOTER)
    .replace(/\{\{STORE_BUTTONS\}\}/g, storeButtons())
    .replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => (key in SITE ? esc(SITE[key]) : m));
}

// Page routes → file. Rendered once at start-up and kept in memory.
const PAGES = {
  '/': 'index.html',
  '/privacy': 'privacy.html',
  '/terms': 'terms.html',
  '/support': 'support.html',
  '/delete-account': 'delete-account.html',
};
const ALIASES = { '/privacy-policy': '/privacy', '/terms-of-use': '/terms', '/help': '/support', '/account-deletion': '/delete-account' };
const STATIC = {
  '/site.css': 'text/css; charset=utf-8',
  '/logo.png': 'image/png',
  '/og.png': 'image/png',
  '/favicon.png': 'image/png',
  '/apple-touch-icon.png': 'image/png',
};

const rendered = {};
for (const [route, file] of Object.entries(PAGES)) {
  try { rendered[route] = render(fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8')); }
  catch (err) { console.warn(`[website] could not load ${file}: ${err.message}`); }
}
const files = {};
for (const route of Object.keys(STATIC)) {
  try { files[route] = fs.readFileSync(path.join(PUBLIC_DIR, route.slice(1))); }
  catch (err) { console.warn(`[website] could not load ${route}: ${err.message}`); }
}

function appleAppSiteAssociation() {
  return {
    applinks: {
      apps: [],
      details: APPLE_TEAM_ID ? [{
        appIDs: [`${APPLE_TEAM_ID}.${IOS_BUNDLE_ID}`],
        appID: `${APPLE_TEAM_ID}.${IOS_BUNDLE_ID}`,
        paths: ['/join/*'],
        components: [{ '/': '/join/*' }],
      }] : [],
    },
  };
}

function assetLinks() {
  if (!ANDROID_SHA256.length) return [];
  return [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: ANDROID_PACKAGE, sha256_cert_fingerprints: ANDROID_SHA256 },
  }];
}

/**
 * Serve a website request. Returns true if handled (response sent).
 */
function serveWebsite(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { return false; }
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  if (pathname.endsWith('.html')) pathname = pathname === '/index.html' ? '/' : pathname.slice(0, -5);

  const send = (status, type, body, cache) => {
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  };

  if (ALIASES[pathname]) {
    res.writeHead(301, { Location: ALIASES[pathname] });
    res.end();
    return true;
  }
  if (rendered[pathname]) return send(200, 'text/html; charset=utf-8', rendered[pathname], 'public, max-age=300');
  if (files[pathname]) return send(200, STATIC[pathname], files[pathname], 'public, max-age=86400');
  if (pathname === '/.well-known/apple-app-site-association' || pathname === '/apple-app-site-association') {
    return send(200, 'application/json', JSON.stringify(appleAppSiteAssociation()), 'public, max-age=3600');
  }
  if (pathname === '/.well-known/assetlinks.json') {
    return send(200, 'application/json', JSON.stringify(assetLinks()), 'public, max-age=3600');
  }
  if (pathname === '/robots.txt') return send(200, 'text/plain; charset=utf-8', `User-agent: *\nDisallow: /join/\nSitemap: ${SITE.SITE_URL}/sitemap.xml\n`, 'public, max-age=86400');
  if (pathname === '/sitemap.xml') {
    const urls = Object.keys(PAGES).map((p) => `<url><loc>${esc(SITE.SITE_URL + (p === '/' ? '/' : p))}</loc></url>`).join('');
    return send(200, 'application/xml', `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`, 'public, max-age=86400');
  }
  return false;
}

if (!APPLE_TEAM_ID) console.warn('[website] APPLE_TEAM_ID not set: iOS will not open join links directly in the app');
if (!ANDROID_SHA256.length) console.warn('[website] ANDROID_SHA256_FINGERPRINTS not set: Android will not open join links directly in the app');

module.exports = { serveWebsite, storeButtons, SITE };
