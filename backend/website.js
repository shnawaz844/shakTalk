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

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, 'public');
const IOS_BUNDLE_ID = 'com.cis.shaktranslate';
const ANDROID_PACKAGE = 'com.cis.shaktranslate';

const SITE = {
  SITE_URL: process.env.SITE_URL || 'https://www.shaktalk.com',
  SUPPORT_EMAIL: process.env.SUPPORT_EMAIL || 'support@shaktalk.com',
  COMPANY_NAME: process.env.COMPANY_NAME || 'ShakTalk',
  LEGAL_ENTITY_NAME: process.env.LEGAL_ENTITY_NAME || 'ShakTalk Technologies Pvt. Ltd.',
  COMPANY_ADDRESS: process.env.COMPANY_ADDRESS || '[registered address]',
  GRIEVANCE_OFFICER: process.env.GRIEVANCE_OFFICER || '[name of grievance officer]',
  GOVERNING_LAW: process.env.GOVERNING_LAW || 'India',
  POLICY_DATE: process.env.POLICY_DATE || '1 November 2026',
  // Store links. The App Store link is known only after Apple approves the
  // app: until APP_STORE_URL is set, the button shows "Coming soon".
  PLAY_STORE_URL: process.env.PLAY_STORE_URL || `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}`,
  APP_STORE_URL: process.env.APP_STORE_URL || '',
  GA_MEASUREMENT_ID: process.env.GA_MEASUREMENT_ID || '',
};
// App links: Apple Team ID (developer.apple.com → Membership) and the SHA-256
// fingerprint(s) of the Android signing key (Play Console → App integrity →
// App signing). Comma-separate several fingerprints.
const APPLE_TEAM_ID = process.env.APPLE_TEAM_ID || '';
const ANDROID_SHA256 = (process.env.ANDROID_SHA256_FINGERPRINTS || '').split(',').map((s) => s.trim()).filter(Boolean);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const APPLE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.37 12.6c-.02-2.27 1.86-3.36 1.94-3.41-1.06-1.55-2.7-1.76-3.28-1.78-1.4-.14-2.73.82-3.44.82-.71 0-1.8-.8-2.96-.78-1.52.02-2.93.89-3.71 2.25-1.59 2.75-.41 6.81 1.13 9.04.76 1.09 1.65 2.31 2.82 2.27 1.14-.05 1.57-.73 2.94-.73 1.37 0 1.76.73 2.96.71 1.22-.02 1.99-1.11 2.73-2.21.87-1.27 1.22-2.5 1.24-2.56-.03-.01-2.38-.91-2.4-3.62zM14.12 5.94c.62-.76 1.05-1.8.93-2.85-.9.04-2 .6-2.64 1.35-.57.66-1.08 1.73-.94 2.75 1 .08 2.02-.51 2.65-1.25z"/></svg>';
const PLAY_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#00D7FE" d="M3.6 2.3c-.3.3-.4.7-.4 1.2v17c0 .5.1.9.4 1.2l9.5-9.7z"/><path fill="#FFCE00" d="M16.3 15.2 13.1 12l3.2-3.2 3.8 2.2c1.1.6 1.1 1.6 0 2.2z"/><path fill="#FF3A44" d="M16.3 15.2 13.1 12l-9.5 9.7c.4.4 1 .4 1.7 0z"/><path fill="#00F076" d="M16.3 8.8 5.3 2.3c-.7-.4-1.3-.4-1.7 0l9.5 9.7z"/></svg>';
const BELL_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2zm-2 1H8v-6c0-2.48 1.51-4.5 4-4.5s4 2.02 4 4.5v6z"/></svg>';
const CALENDAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>';

function storeButtons() {
  const playSoon = `<div class="store-btn soon" aria-disabled="true" role="button" tabindex="-1">${PLAY_SVG}<span><small>Google Play</small><strong>Coming soon</strong></span></div>`;
  const appleSoon = `<div class="store-btn soon" aria-disabled="true" role="button" tabindex="-1">${APPLE_SVG}<span><small>App Store</small><strong>Coming soon</strong></span></div>`;
  const notifyBtn = `<button type="button" class="btn btn-notify" data-open-waitlist aria-haspopup="dialog" aria-controls="waitlist-modal">${BELL_SVG}<span>Notify me</span></button>`;
  const demoBtn = `<button type="button" class="btn btn-demo" data-open-demo aria-haspopup="dialog" aria-controls="demo-modal">${CALENDAR_SVG}<span>Book a live demo</span></button>`;

  return `<div class="store-block"><div class="store-row">${playSoon}${appleSoon}</div><div class="store-notify-row">${notifyBtn}${demoBtn}</div></div>`;
}

// Schema markup snippets — per-page JSON-LD injected in each page's <head>
const SCHEMA_ORG = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "ShakTalk",
  "url": SITE.SITE_URL,
  "logo": `${SITE.SITE_URL}/logo.png`,
  "sameAs": [],
  "contactPoint": [{
    "@type": "ContactPoint",
    "email": SITE.SUPPORT_EMAIL,
    "contactType": "customer support"
  }]
});

const SCHEMA_APP = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "ShakTalk",
  "applicationCategory": "CommunicationApplication",
  "operatingSystem": "iOS, Android",
  "description": "Real-time two-way AI voice translation app. Speak your language, they hear theirs — live, on a call or face to face. Supports 17 languages including English, Hindi, Arabic, Mandarin, Spanish, French, and more.",
  "url": SITE.SITE_URL,
  "downloadUrl": SITE.PLAY_STORE_URL,
  "inLanguage": ["en", "hi", "ar", "zh", "es", "fr", "de", "ja", "ko", "ur", "ru", "it", "pt", "tr", "ro", "fa"],
  "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
  "author": { "@type": "Organization", "name": "ShakTalk" }
});

const SCHEMA_WEBSITE = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "WebSite",
  "name": "ShakTalk",
  "url": SITE.SITE_URL
});

const HEAD = `  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0A0D0C">
  <meta name="robots" content="index, follow">
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="sitemap" type="application/xml" href="/sitemap.xml">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="ShakTalk">
  <meta property="og:image" content="${esc(SITE.SITE_URL)}/og.png">
  <meta property="og:image:alt" content="ShakTalk — Real-time voice translation app">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:site" content="@ShakTalkApp">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/site.css?v=21">
  ${SITE.GA_MEASUREMENT_ID ? `<!-- Google Analytics 4 (GA4) -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=${esc(SITE.GA_MEASUREMENT_ID)}"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', '${esc(SITE.GA_MEASUREMENT_ID)}');
    function trackEvent(name, params) {
      if (typeof window.gtag === 'function') {
        window.gtag('event', name, params || {});
      }
    }
  </script>` : `<script>function trackEvent(name, params) {}</script>`}`;

const HEADER = `<header class="site-header">
  <div class="wrap">
    <a class="brand" href="/"><img src="/logo.png" alt="ShakTalk" width="36" height="36"><span>Shak<b>Talk</b></span></a>
    <div class="header-actions">
      <a class="btn btn-primary btn-header-try" href="/#get">Try it now</a>
      <button type="button" class="nav-toggle" aria-label="Menu" aria-expanded="false" aria-controls="site-nav">☰</button>
    </div>
    <nav id="site-nav" class="nav" aria-label="Main">
      <a href="/why-shaktalk">Why ShakTalk</a>
      <a href="/features">Features</a>
      <a href="/how-it-works">How it works</a>
      <a href="/industries">Industries</a>
      <a href="/faq">FAQ</a>
      <a href="/business">Business</a>
      <a href="/support">Support</a>
      <a class="btn btn-primary nav-try-desktop" href="/#get">Try it now</a>
    </nav>
  </div>
  <script>
  (function() {
    var t = document.querySelector('.nav-toggle');
    var n = document.getElementById('site-nav');
    if (t && n) {
      t.addEventListener('click', function() {
        var open = n.classList.toggle('open');
        t.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      n.querySelectorAll('a').forEach(function(a) {
        a.addEventListener('click', function() {
          n.classList.remove('open');
          t.setAttribute('aria-expanded', 'false');
        });
      });
      document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && n.classList.contains('open')) {
          n.classList.remove('open');
          t.setAttribute('aria-expanded', 'false');
        }
      });
    }
  })();
  </script>
</header>`;

const FOOTER = `<footer class="site-footer">
  <div class="wrap">
    <div>© ${new Date().getFullYear()} ${esc(SITE.LEGAL_ENTITY_NAME)}. All rights reserved.</div>
    <nav aria-label="Footer">
      <a href="/features">Features</a>
      <a href="/business">Business</a>
      <a href="/faq">FAQ</a>
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms</a>
      <a href="/support">Support</a>
      <a href="/delete-account">Delete account</a>
      <a href="mailto:${esc(SITE.SUPPORT_EMAIL)}">${esc(SITE.SUPPORT_EMAIL)}</a>
    </nav>
  </div>
  <script>
  (function() {
    document.addEventListener('click', function(e) {
      // 1. support_email_click: any mailto link
      var mailto = e.target.closest('a[href^="mailto:"]');
      if (mailto) {
        var email = mailto.getAttribute('href').replace(/^mailto:/i, '').split('?')[0];
        if (typeof trackEvent === 'function') {
          trackEvent('support_email_click', { email: email, path: window.location.pathname });
        }
        return;
      }
      // 2. demo_click: any Book a live demo button
      var demo = e.target.closest('[data-open-demo], [data-event="demo_click"], .btn-demo');
      if (demo) {
        if (typeof trackEvent === 'function') {
          trackEvent('demo_click', { path: window.location.pathname });
        }
        return;
      }
      // 3. play_store_click: any Google Play badge
      var play = e.target.closest('a[href*="play.google.com"], .store-btn');
      if (play && (play.textContent.includes('Google Play') || (play.href && play.href.includes('play.google.com')))) {
        if (typeof trackEvent === 'function') {
          trackEvent('play_store_click', { path: window.location.pathname });
        }
        return;
      }
    });
  })();
  </script>
</footer>`;

function render(html, extraSchema) {
  let head = HEAD;
  if (extraSchema) head += `\n  <script type="application/ld+json">${extraSchema}<\/script>`;
  return html
    .replace(/\{\{HEAD\}\}/g, head)
    .replace(/\{\{HEADER\}\}/g, HEADER)
    .replace(/\{\{FOOTER\}\}/g, FOOTER)
    .replace(/\{\{STORE_BUTTONS\}\}/g, storeButtons())
    .replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => (key in SITE ? esc(SITE[key]) : m));
}

// Page routes → file. Rendered once at start-up and kept in memory.
const PAGES = {
  '/': 'index.html',
  '/why-shaktalk': 'index.html',
  '/how-it-works': 'index.html',
  '/industries': 'index.html',
  '/privacy': 'privacy.html',
  '/terms': 'terms.html',
  '/support': 'support.html',
  '/delete-account': 'delete-account.html',
  '/faq': 'faq.html',
  '/features': 'features.html',
  '/business': 'business.html',
  '/use-cases/importers': 'use-cases/importers.html',
  '/use-cases/hotels': 'use-cases/hotels.html',
  '/use-cases/hospitals': 'use-cases/hospitals.html',
  '/use-cases/real-estate': 'use-cases/real-estate.html',
  '/use-cases/travel': 'use-cases/travel.html',
  '/languages/hindi-to-chinese': 'languages/hindi-to-chinese.html',
  '/languages/arabic-to-hindi': 'languages/arabic-to-hindi.html',
};
const ALIASES = {
  '/privacy-policy': '/privacy',
  '/terms-of-use': '/terms',
  '/help': '/support',
  '/account-deletion': '/delete-account',
  '/why': '/why-shaktalk',
  '/problem': '/why-shaktalk',
  '/how': '/how-it-works',
  '/use-cases': '/industries',
  '/languages': '/',
};
const STATIC = {
  '/site.css': 'text/css; charset=utf-8',
  '/logo.png': 'image/png',
  '/og.png': 'image/png',
  '/favicon.png': 'image/png',
  '/apple-touch-icon.png': 'image/png',
  '/hero-phones.png': 'image/png',
  '/hero-phones.webp': 'image/webp',
  '/how-qr.png': 'image/png',
  '/how-qr.webp': 'image/webp',
  '/sitemap.xml': 'application/xml; charset=utf-8',
  '/robots.txt': 'text/plain; charset=utf-8',
};

const rendered = {};
for (const [route, file] of Object.entries(PAGES)) {
  try {
    rendered[route] = render(fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8'));
  }
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
  const isDev = process.env.NODE_ENV !== 'production';

  if (PAGES[pathname]) {
    try {
      const file = PAGES[pathname];
      const html = isDev
        ? render(fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8'))
        : (rendered[pathname] || render(fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8')));
      return send(200, 'text/html; charset=utf-8', html, isDev ? 'no-cache' : 'public, max-age=300');
    } catch (e) {
      if (rendered[pathname]) return send(200, 'text/html; charset=utf-8', rendered[pathname], 'public, max-age=300');
    }
  }
  if (pathname === '/favicon.ico') pathname = '/favicon.png';
  if (STATIC[pathname]) {
    try {
      const content = isDev
        ? fs.readFileSync(path.join(PUBLIC_DIR, pathname.slice(1)))
        : (files[pathname] || fs.readFileSync(path.join(PUBLIC_DIR, pathname.slice(1))));
      return send(200, STATIC[pathname], content, isDev ? 'no-cache' : 'public, max-age=86400');
    } catch (e) {
      if (files[pathname]) return send(200, STATIC[pathname], files[pathname], 'public, max-age=86400');
    }
  }
  if (pathname === '/.well-known/apple-app-site-association' || pathname === '/apple-app-site-association') {
    return send(200, 'application/json', JSON.stringify(appleAppSiteAssociation()), 'public, max-age=3600');
  }
  if (pathname === '/.well-known/assetlinks.json') {
    return send(200, 'application/json', JSON.stringify(assetLinks()), 'public, max-age=3600');
  }
  if (pathname === '/robots.txt') return send(200, 'text/plain; charset=utf-8', `User-agent: *\nAllow: /\nDisallow: /join/\nDisallow: /admin\nSitemap: ${SITE.SITE_URL}/sitemap.xml\n`, 'public, max-age=86400');
  if (pathname === '/sitemap.xml') {
    const today = new Date().toISOString().split('T')[0];
    const priorityMap = { '/': '1.0', '/features': '0.9', '/faq': '0.9', '/business': '0.8' };
    const urls = Object.keys(PAGES).map((p) => {
      const loc = esc(SITE.SITE_URL + (p === '/' ? '/' : p));
      const priority = priorityMap[p] || '0.7';
      return `<url><loc>${loc}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>${priority}</priority></url>`;
    }).join('');
    return send(200, 'application/xml', `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`, 'public, max-age=86400');
  }
  return false;
}

if (!APPLE_TEAM_ID) console.warn('[website] APPLE_TEAM_ID not set: iOS will not open join links directly in the app');
if (!ANDROID_SHA256.length) console.warn('[website] ANDROID_SHA256_FINGERPRINTS not set: Android will not open join links directly in the app');

module.exports = { serveWebsite, storeButtons, SITE };
