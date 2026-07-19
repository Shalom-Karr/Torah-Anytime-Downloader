// TorahAnytime reverse proxy + downloader — core request handler.
//
// A single web-standard handler (Request -> Response, global fetch/URL).
// server.mjs runs it on a local Node http server (used both standalone and as
// the desktop app's bundled sidecar). `handleRequest(request)` is the entry;
// it also serves the on-demand remuxer at /__ta__remux.js.
//
// Path-based scheme (NO ?url= wrapper):
//   /                     -> https://www.torahanytime.com/
//   /lectures/123         -> https://www.torahanytime.com/lectures/123
//   /__ta/<host>/<path>   -> https://<host>/<path>   (api, trpc, proxier, ...)
//
// The worker mirrors the site's own path structure, so client code that builds
// a URL by appending a path to a base (tRPC httpBatchLink, Next.js RSC, hls.js)
// keeps working — the appended path extends the worker path instead of being
// dropped, which is what broke the old ?url= proxy.

import { REMUX_JS } from "./remux.mjs";

const SITE_HOST = "www.torahanytime.com";
const SITE_ORIGIN = "https://" + SITE_HOST;
const PREFIX = "/__ta/"; // /__ta/<host>/<path...> for any non-default host

export async function handleRequest(request) {
  const inUrl = new URL(request.url);
  const workerOrigin = inUrl.origin;
  const workerHost = inUrl.host;

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(request) });
  }

  // Serve the fMP4/TS -> flat progressive MP4 remuxer to the injected
  // downloader (loaded on demand so HLS downloads come out seekable).
  if (inUrl.pathname === "/__ta__remux.js") {
    return new Response(REMUX_JS, {
      status: 200,
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
        ...corsHeaders(request),
      },
    });
  }

  const target = resolveTarget(inUrl);
  if (!target) return Response.redirect(workerOrigin + "/", 302);

  const targetUrl = new URL(target);
  if (!hostAllowed(targetUrl.hostname)) return blocked(request, targetUrl);

  const cacheable = isCacheableAsset(targetUrl, request.method);

  const outboundHeaders = new Headers(request.headers);
  outboundHeaders.delete("Host");
  outboundHeaders.delete("cf-connecting-ip");
  outboundHeaders.delete("cf-ipcountry");
  outboundHeaders.delete("cf-ray");
  outboundHeaders.delete("cf-visitor");
  outboundHeaders.delete("cf-worker");
  outboundHeaders.delete("x-forwarded-for");
  outboundHeaders.delete("x-forwarded-proto");
  outboundHeaders.delete("x-forwarded-host");
  outboundHeaders.delete("x-real-ip");
  // Request identity encoding so the upstream body isn't gzip/br compressed.
  // Runtimes disagree on whether a passed-through body is auto-decompressed
  // (undici does, Workers don't); identity avoids emitting a body that no
  // longer matches its Content-Encoding (e.g. favicon ERR_CONTENT_DECODING).
  outboundHeaders.set("Accept-Encoding", "identity");

  // Present requests as if they came from the real site.
  outboundHeaders.set("Referer", SITE_ORIGIN + "/");
  const isNavigation =
    request.method === "GET" &&
    !request.headers.get("Origin") &&
    (request.headers.get("Sec-Fetch-Dest") === "document" ||
      (request.headers.get("Accept") || "").includes("text/html"));
  if (isNavigation) outboundHeaders.delete("Origin");
  else outboundHeaders.set("Origin", SITE_ORIGIN);

  if (cacheable) {
    outboundHeaders.delete("cookie");
    outboundHeaders.delete("authorization");
  }

  const fetchInit = {
    method: request.method,
    headers: outboundHeaders,
    body:
      request.method !== "GET" && request.method !== "HEAD"
        ? request.body
        : undefined,
    redirect: "manual",
  };
  // `duplex` is required by the Node/undici fetch when streaming a request body.
  if (fetchInit.body) fetchInit.duplex = "half";
  if (cacheable) fetchInit.cf = { cacheTtl: 86400, cacheEverything: true };

  let response;
  try {
    response = await fetch(targetUrl.toString(), fetchInit);
  } catch (e) {
    return new Response("Upstream fetch failed: " + e, {
      status: 502,
      headers: corsHeaders(request),
    });
  }

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("Location");
    if (location) {
      const absolute = new URL(location, targetUrl).toString();
      const redirectHeaders = stripBlockingHeaders(new Headers(response.headers));
      Object.entries(corsHeaders(request)).forEach(([k, v]) => redirectHeaders.set(k, v));
      redirectHeaders.set("Referrer-Policy", "unsafe-url");
      rewriteSetCookies(redirectHeaders);
      redirectHeaders.set("Location", toWorker(absolute, workerOrigin));
      return new Response(null, { status: response.status, headers: redirectHeaders });
    }
  }

  const responseHeaders = stripBlockingHeaders(new Headers(response.headers));
  Object.entries(corsHeaders(request)).forEach(([k, v]) => responseHeaders.set(k, v));
  responseHeaders.set("Referrer-Policy", "unsafe-url");
  rewriteSetCookies(responseHeaders);
  // Revalidatable cache only — never `immutable`. Because the proxy rewrites
  // content, an immutable entry can pin a bad build in the browser until expiry.
  if (cacheable) responseHeaders.set("Cache-Control", "public, max-age=3600");

  const contentType = (response.headers.get("Content-Type") || "").toLowerCase();
  const path = targetUrl.pathname.toLowerCase();
  const isHtml = contentType.includes("text/html");
  const isCss = contentType.includes("text/css");
  const isJs = contentType.includes("javascript") || contentType.includes("ecmascript");
  const isJson = contentType.includes("application/json") || contentType.includes("+json");
  const isXml = contentType.includes("xml");
  const isRsc = contentType.includes("text/x-component");
  const isManifest = contentType.includes("manifest") || path.endsWith("manifest.json");
  const isM3u8 = contentType.includes("mpegurl") || path.endsWith(".m3u8");

  // Identity was requested, so a passthrough body still matches its
  // Content-Length — keep it (needed for download progress % and HEAD size).
  // Only a stale Content-Encoding (upstream ignored identity) forces dropping
  // both, since the runtime already decoded the body.
  const hadEncoding = !!response.headers.get("Content-Encoding");
  responseHeaders.delete("Content-Encoding");
  if (hadEncoding) responseHeaders.delete("Content-Length");

  const needsRewrite =
    isHtml || isCss || isJs || isJson || isXml || isRsc || isManifest || isM3u8;
  if (!needsRewrite) {
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  }

  let text;
  try {
    text = await response.text();
  } catch (e) {
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  }

  if (isHtml) text = rewriteHtml(text, targetUrl, workerOrigin, workerHost);
  else if (isCss) text = rewriteCss(text, targetUrl, workerOrigin);
  else if (isJs) text = rewriteJs(text, targetUrl, workerOrigin);
  else if (isM3u8) text = rewriteM3u8(text, targetUrl, workerOrigin);
  else if (isRsc) {
    // Next.js RSC "flight" payloads use length-prefixed rows (e.g. `a:T2b4,<...>`).
    // Rewriting URL strings changes their byte length without updating the prefix,
    // which desyncs React's parser and crashes hydration ("Cannot set properties
    // of undefined (setting 'color')"). Leave RSC byte-for-byte; the injected
    // runtime hooks proxy any request it later triggers.
  } else text = rewriteData(text, targetUrl, workerOrigin);

  responseHeaders.delete("Content-Length");
  responseHeaders.delete("Content-Encoding");
  return new Response(text, { status: response.status, headers: responseHeaders });
}

const CACHEABLE_EXT =
  /\.(?:js|mjs|css|woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif|ico|mp3|mp4|m4a|m4v|m4s|webm|ogg|wav|ts)(?:$|\?)/i;

// ---- routing -------------------------------------------------------------

function resolveTarget(inUrl) {
  let host, path;
  if (inUrl.pathname.startsWith(PREFIX)) {
    const rest = inUrl.pathname.slice(PREFIX.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      host = rest;
      path = "/";
    } else {
      host = rest.slice(0, slash);
      path = rest.slice(slash);
    }
    host = decodeURIComponent(host);
  } else {
    host = SITE_HOST;
    path = inUrl.pathname;
  }
  if (!/^[a-z0-9.\-]+(?::\d+)?$/i.test(host) || host.indexOf(".") === -1) return null;
  // Loopback and `*.localhost` are never upstream targets — they're this
  // machine (the Tauri shell serves index.html from http://tauri.localhost on
  // Windows). Treat them as "no target" so the caller redirects to the proxy
  // root instead of failing DNS with an opaque "Upstream fetch failed".
  const bare = host.replace(/:\d+$/, "").toLowerCase();
  if (bare === "localhost" || bare.endsWith(".localhost") || /^127\./.test(bare)) return null;
  return "https://" + host + path + inUrl.search;
}

function sameSite(host) {
  return host.toLowerCase() === SITE_HOST;
}

// Spec / XML-namespace / metadata URLs that appear as string identifiers, not
// as fetchable resources. Proxying them corrupts SVG/RDF/OpenGraph handling.
const NAMESPACE_HOST =
  /^(?:https?:)?\/\/(?:www\.)?(?:w3\.org|schema\.org|ns\.adobe\.com|purl\.org|xmlns\.com|gmpg\.org|iptc\.org|creativecommons\.org|ogp\.me|npmjs\.org)\b/i;
function isNamespaceUrl(u) {
  return NAMESPACE_HOST.test(u);
}

// Build a worker-absolute URL for a target URL found in page content.
function toWorker(absUrl, workerOrigin) {
  try {
    const u = new URL(absUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return absUrl;
    if (sameSite(u.hostname)) return workerOrigin + u.pathname + u.search + u.hash;
    return workerOrigin + PREFIX + u.host + u.pathname + u.search + u.hash;
  } catch (e) {
    return absUrl;
  }
}

// Donations / checkout / analytics / chat that can't work behind a proxy
// (Stripe refuses to load proxied) or aren't needed to view/download lectures.
// Short-circuiting them removes their console errors and stray network noise.
const NON_ESSENTIAL_HOSTS =
  /(?:^|\.)(?:stripe\.com|stripecdn\.com|double\.giving|google-analytics\.com|googletagmanager\.com|analytics\.google\.com|doubleclick\.net|facebook\.com|facebook\.net|fbcdn\.net|tawk\.to|luckyorange\.com|hotjar\.com|cloudflareinsights\.com|radar\.cloudflare\.com|app-us1\.com|trackcmp\.net)$/i;

// Proxy any valid host the page references (nothing leaks past the filter and
// the app never gets a starved response for a resource it depends on), except
// the non-essential third parties above, which are short-circuited.
function hostAllowed(host) {
  host = (host || "").toLowerCase();
  if (!host.includes(".") || /^[.\-]|[.\-]$/.test(host)) return false;
  if (NON_ESSENTIAL_HOSTS.test(host)) return false;
  return true;
}

function blocked(request, targetUrl) {
  // never cache a block, so removing a host from the list takes effect at once
  const base = { ...corsHeaders(request), "Cache-Control": "no-store" };
  const dest = (request.headers.get("Sec-Fetch-Dest") || "").toLowerCase();
  const host = targetUrl ? targetUrl.hostname.toLowerCase() : "";
  // Stripe: serve a harmless `window.Stripe` stub so the app's loader check
  // passes instead of throwing "Stripe.js not available". Donations can't work
  // behind a proxy anyway; any later Stripe call becomes a safe no-op.
  if (/(?:^|\.)js\.stripe\.com$/.test(host) && (dest === "script" || dest === "" || dest === "empty")) {
    const stub =
      "window.Stripe=function(){var n=function(){return n;};" +
      "return new Proxy(function(){},{get:function(){return n;},apply:function(){return {};}});};" +
      "window.Stripe.version=3;";
    return new Response(stub, { status: 200, headers: { ...base, "Content-Type": "text/javascript" } });
  }
  // Return a benign, type-appropriate stub so the blocked resource neither
  // executes nor makes the caller throw (e.g. `.json()` on an empty body).
  if (dest === "script" || dest === "worker" || dest === "serviceworker") {
    return new Response("", { status: 200, headers: { ...base, "Content-Type": "text/javascript" } });
  }
  if (dest === "style") {
    return new Response("", { status: 200, headers: { ...base, "Content-Type": "text/css" } });
  }
  if (dest === "" || dest === "empty") {
    // fetch / XHR / sendBeacon — most expect JSON; empty object keeps them quiet.
    return new Response("{}", { status: 200, headers: { ...base, "Content-Type": "application/json" } });
  }
  return new Response(null, { status: 204, headers: base });
}

function isCacheableAsset(targetUrl, method) {
  if (method !== "GET" && method !== "HEAD") return false;
  if (CACHEABLE_EXT.test(targetUrl.pathname)) return true;
  if (/\/(static|assets|s|cssbin|jsbin|imgbin|fonts?)\//i.test(targetUrl.pathname)) return true;
  return false;
}

// ---- header helpers ------------------------------------------------------

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, PATCH, DELETE",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Credentials": origin ? "true" : "false",
    "Access-Control-Expose-Headers": "*",
    "Access-Control-Max-Age": "86400",
  };
}

function stripBlockingHeaders(headers) {
  headers.delete("Content-Security-Policy");
  headers.delete("Content-Security-Policy-Report-Only");
  headers.delete("X-Frame-Options");
  headers.delete("Cross-Origin-Embedder-Policy");
  headers.delete("Cross-Origin-Opener-Policy");
  headers.delete("Cross-Origin-Resource-Policy");
  headers.delete("Strict-Transport-Security");
  headers.delete("Permissions-Policy");
  headers.delete("Feature-Policy");
  return headers;
}

function rewriteSetCookies(headers) {
  const cookies = headers.getSetCookie ? headers.getSetCookie() : [];
  if (!cookies.length) return;
  headers.delete("Set-Cookie");
  for (const cookie of cookies) {
    const parts = cookie.split(";").map((p) => p.trim());
    const filtered = parts.filter((p) => {
      const lower = p.toLowerCase();
      return (
        !lower.startsWith("domain=") &&
        !lower.startsWith("path=") &&
        !lower.startsWith("samesite=") &&
        !lower.startsWith("secure")
      );
    });
    if (filtered[0] && /^__(host|secure)-/i.test(filtered[0])) {
      filtered[0] = filtered[0].replace(/^__(host|secure)-/i, "");
    }
    filtered.push("Path=/", "SameSite=None", "Secure");
    headers.append("Set-Cookie", filtered.join("; "));
  }
}

// ---- URL rewriting -------------------------------------------------------

function decodeEntities(s) {
  if (!s || s.indexOf("&") === -1) return s;
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#x3A;/gi, ":")
    .replace(/&#x3F;/gi, "?")
    .replace(/&#x3D;/gi, "=")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

function resolveAndProxy(u, targetUrl, workerOrigin) {
  if (!u) return u;
  u = decodeEntities(u);
  const t = u.trim();
  if (!t) return u;
  if (/^(javascript:|data:|mailto:|tel:|blob:|about:|vbscript:|#)/i.test(t)) return u;
  if (t.indexOf(workerOrigin) === 0) return u;
  if (isNamespaceUrl(t)) return u;
  if (t.startsWith("//")) return toWorker("https:" + t, workerOrigin);
  if (/^https?:\/\//i.test(t)) return toWorker(t, workerOrigin);
  if (t.startsWith("/")) {
    // root-relative: on the default site it resolves naturally against the
    // worker root; on a sub-host it must be pinned to that host.
    if (sameSite(targetUrl.hostname)) return u;
    return toWorker(targetUrl.origin + t, workerOrigin);
  }
  return u; // relative path resolves naturally
}

function rewriteHtml(text, targetUrl, workerOrigin, workerHost) {
  // SRI hashes can't match once the referenced asset is proxied — drop them,
  // otherwise the browser blocks the (now same-origin) script/stylesheet.
  text = text.replace(/\s+integrity\s*=\s*(["'])[^"']*\1/gi, "");

  // Drop preload/prefetch/preconnect <link>s that point at blocked hosts
  // (Facebook pixel, Double, LuckyOrange, GA/GTM). Their target is short-
  // circuited anyway, so the hint only produces "preloaded but not used"
  // warnings and wasted requests. Same-origin/_next and media hints are kept.
  text = text.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/\brel\s*=\s*["']?(?:preload|prefetch|preconnect|dns-prefetch|modulepreload)\b/i.test(tag)) return tag;
    const href = (tag.match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1] || "";
    try {
      if (NON_ESSENTIAL_HOSTS.test(new URL(decodeEntities(href), targetUrl).hostname)) return "";
    } catch (e) {}
    return tag;
  });

  const placeholders = [];
  text = text.replace(
    /<(script|style|textarea|pre)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi,
    (m, tag, attrs, body) => {
      attrs = attrs || "";
      attrs = attrs.replace(
        /\b(src|href)\s*=\s*(["'])([^"']+)\2/gi,
        (am, attr, q, value) =>
          `${attr}=${q}${resolveAndProxy(value, targetUrl, workerOrigin)}${q}`
      );
      let newBody = body;
      if (tag.toLowerCase() === "script") {
        const typeMatch = attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i);
        const scriptType = typeMatch ? typeMatch[1].toLowerCase() : "";
        const isExecutable =
          !scriptType ||
          scriptType === "text/javascript" ||
          scriptType === "application/javascript" ||
          scriptType === "application/ecmascript" ||
          scriptType === "module";
        if (!isExecutable) {
          newBody = rewriteData(body, targetUrl, workerOrigin);
        }
      }
      const idx = placeholders.length;
      placeholders.push(`<${tag}${attrs}>${newBody}</${tag}>`);
      return `\x00PH${idx}\x00`;
    }
  );

  text = text.replace(
    /\b(href|src|action|formaction|poster|data-src|data-href|background|cite|longdesc|usemap)\s*=\s*(["'])([^"']+)\2/gi,
    (m, attr, q, value) =>
      `${attr}=${q}${resolveAndProxy(value, targetUrl, workerOrigin)}${q}`
  );

  text = text.replace(/\bsrcset\s*=\s*(["'])([^"']+)\1/gi, (m, q, value) => {
    const parts = value.split(",").map((p) => {
      const t = p.trim();
      const sp = t.search(/\s/);
      const u = sp > 0 ? t.slice(0, sp) : t;
      const d = sp > 0 ? t.slice(sp) : "";
      return resolveAndProxy(u, targetUrl, workerOrigin) + d;
    });
    return `srcset=${q}${parts.join(", ")}${q}`;
  });

  text = text.replace(/<meta[^>]+name=["']referrer["'][^>]*>/gi, "");
  text = text.replace(/<meta[^>]+http-equiv=["']referrer["'][^>]*>/gi, "");
  // An existing <base> would fight the path scheme; drop it.
  text = text.replace(/<base[^>]*>/gi, "");

  // Inject as the first child of <head> so hooks install before any app code,
  // but the script deletes its own node immediately (see injectedScript). React
  // then never sees an extra element during hydration. Referrer policy comes
  // from the Referrer-Policy header, so no <meta> is injected: an injected head
  // node shifts App Router's head reconciliation by one and crashes it with
  // "Cannot set properties of undefined (setting 'color')".
  const headInjection = injectedScript(workerOrigin, workerHost);

  if (/<head([^>]*)>/i.test(text)) {
    text = text.replace(/<head([^>]*)>/i, `<head$1>${headInjection}`);
  } else if (/<html([^>]*)>/i.test(text)) {
    text = text.replace(/<html([^>]*)>/i, `<html$1><head>${headInjection}</head>`);
  } else {
    text = headInjection + text;
  }

  text = text.replace(/\x00PH(\d+)\x00/g, (m, idx) => placeholders[Number(idx)]);
  return text;
}

function rewriteCss(text, targetUrl, workerOrigin) {
  return text.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q, value) => {
    if (/^data:/i.test(value)) return m;
    return `url(${q}${resolveAndProxy(value, targetUrl, workerOrigin)}${q})`;
  });
}

function rewriteJs(text) {
  // Intentional passthrough. Rewriting URL-like strings inside minified bundles
  // corrupts identifiers that only LOOK like resource URLs — above all the XML
  // namespaces compiled into React DOM ("http://www.w3.org/2000/svg", xlink,
  // MathML). Rewriting those breaks createElementNS: the SVG nodes are no longer
  // real elements, so node.style is undefined and React throws
  // "Cannot set properties of undefined (setting 'color')" during commit.
  // Every genuine network request is proxied at runtime by the injected
  // fetch / XHR / sendBeacon / element-property hooks instead.
  return text;
}

function rewriteData(text, targetUrl, workerOrigin) {
  text = text.replace(
    /(["'`])(https?:\/\/[a-z0-9.\-]+\.[a-z]{2,}[^"'`\s<>\\]*)/gi,
    (m, q, u) => `${q}${resolveAndProxy(u, targetUrl, workerOrigin)}`
  );
  text = text.replace(
    /(["'`])(\/\/[a-z0-9.\-]+\.[a-z]{2,}[^"'`\s<>\\]*)/gi,
    (m, q, u) => `${q}${resolveAndProxy(u, targetUrl, workerOrigin)}`
  );
  return text;
}

// HLS playlists: URLs sit on bare lines, plus URI="..." on some #EXT tags.
function rewriteM3u8(text, targetUrl, workerOrigin) {
  return text
    .split("\n")
    .map((line) => {
      const l = line.trim();
      if (!l) return line;
      if (l[0] === "#") {
        return line.replace(
          /URI="([^"]+)"/gi,
          (m, uri) => `URI="${resolveAndProxy(uri, targetUrl, workerOrigin)}"`
        );
      }
      return resolveAndProxy(l, targetUrl, workerOrigin);
    })
    .join("\n");
}

// ---- injected client runtime --------------------------------------------

function injectedScript(workerOrigin, workerHost) {
  return `<script>(function(){
    // Remove our own node right away so React's hydration never sees an extra
    // element in <head> (which would shift head reconciliation and crash).
    try{ var _s=document.currentScript; if(_s&&_s.parentNode) _s.parentNode.removeChild(_s); }catch(e){}
    var WORKER=${JSON.stringify(workerOrigin)};
    var WORKER_HOST=${JSON.stringify(workerHost)};
    var SITE_HOST=${JSON.stringify(SITE_HOST)};
    var PREFIX=${JSON.stringify(PREFIX)};
    function toProxy(u){
      if(u==null) return u;
      try{
        if(typeof u !== 'string'){ if(u instanceof URL) u=u.toString(); else u=String(u); }
        var t=u.trim();
        if(!t) return u;
        if(/^(javascript:|data:|mailto:|tel:|blob:|about:|#)/i.test(t)) return u;
        if(t.indexOf(WORKER)===0) return u;
        if(/^(?:https?:)?\\/\\/(?:www\\.)?(?:w3\\.org|schema\\.org|ns\\.adobe\\.com|purl\\.org|xmlns\\.com|gmpg\\.org|ogp\\.me)\\b/i.test(t)) return u;
        if(t.indexOf('//')===0){ return toProxy('https:'+t); }
        if(/^https?:\\/\\//i.test(t)){
          var m=t.match(/^https?:\\/\\/([^\\/?#]+)(.*)$/i);
          if(!m) return u;
          var host=m[1].toLowerCase(), rest=m[2]||'';
          if(host===WORKER_HOST) return u;
          if(host===SITE_HOST) return WORKER + (rest || '/');
          return WORKER + PREFIX + host + rest;
        }
        return u;
      }catch(e){return u;}
    }

    var origFetch = window.fetch;
    if(origFetch){
      window.fetch = function(input, init){
        try{
          if(typeof input === 'string'){ input = toProxy(input); recordHls(input); }
          else if(input && input.url){
            var newUrl = toProxy(input.url);
            if(newUrl !== input.url) input = new Request(newUrl, input);
            recordHls(newUrl);
          }
        }catch(e){}
        return origFetch.call(this, input, init);
      };
    }

    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url){
      try{ arguments[1] = toProxy(url); recordHls(arguments[1]); }catch(e){}
      return origOpen.apply(this, arguments);
    };

    if(navigator.sendBeacon){
      var origBeacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function(url, data){ return origBeacon(toProxy(url), data); };
    }

    try{
      var locProto = Location.prototype;
      var hrefDesc = Object.getOwnPropertyDescriptor(locProto, 'href');
      if(hrefDesc && hrefDesc.set){
        Object.defineProperty(locProto, 'href', {
          get: hrefDesc.get,
          set: function(v){ return hrefDesc.set.call(this, toProxy(v)); },
          configurable: true
        });
      }
      var origAssign = locProto.assign;
      locProto.assign = function(v){ return origAssign.call(this, toProxy(v)); };
      var origReplace = locProto.replace;
      locProto.replace = function(v){ return origReplace.call(this, toProxy(v)); };
    }catch(e){}

    try{
      if(typeof Window !== 'undefined'){
        var winLocDesc = Object.getOwnPropertyDescriptor(Window.prototype, 'location');
        if(winLocDesc && winLocDesc.set){
          Object.defineProperty(Window.prototype, 'location', {
            get: winLocDesc.get,
            set: function(v){
              try{ if(typeof v === 'string') v = toProxy(v); }catch(e){}
              return winLocDesc.set.call(this, v);
            },
            configurable: true
          });
        }
      }
    }catch(e){}

    try{
      var origWinOpen = window.open;
      window.open = function(u, t, f){ return origWinOpen.call(window, toProxy(u), t, f); };
    }catch(e){}

    try{
      var origPush = history.pushState;
      history.pushState = function(state, title, url){
        try{ taMaybeReset(url); }catch(e){}
        try{ if(url != null) url = toProxy(url); }catch(e){}
        return origPush.call(this, state, title, url);
      };
      var origReplaceState = history.replaceState;
      history.replaceState = function(state, title, url){
        try{ taMaybeReset(url); }catch(e){}
        try{ if(url != null) url = toProxy(url); }catch(e){}
        return origReplaceState.call(this, state, title, url);
      };
    }catch(e){}

    var origSetAttr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value){
      try{
        if(typeof name === 'string' && /^(src|href|action|formaction|poster|data-src|background)$/i.test(name)){
          value = toProxy(value);
        } else if(typeof name === 'string' && name.toLowerCase() === 'srcset' && typeof value === 'string'){
          value = value.split(',').map(function(p){
            var t = p.trim();
            var sp = t.search(/\\s/);
            var u = sp > 0 ? t.slice(0, sp) : t;
            var d = sp > 0 ? t.slice(sp) : '';
            return toProxy(u) + d;
          }).join(', ');
        }
      }catch(e){}
      return origSetAttr.call(this, name, value);
    };

    function hookProp(proto, prop){
      try{
        var desc = Object.getOwnPropertyDescriptor(proto, prop);
        if(!desc || !desc.set) return;
        Object.defineProperty(proto, prop, {
          get: desc.get,
          set: function(v){ return desc.set.call(this, toProxy(v)); },
          configurable: true
        });
      }catch(e){}
    }
    if(typeof HTMLImageElement !== 'undefined') hookProp(HTMLImageElement.prototype, 'src');
    if(typeof HTMLScriptElement !== 'undefined') hookProp(HTMLScriptElement.prototype, 'src');
    if(typeof HTMLIFrameElement !== 'undefined') hookProp(HTMLIFrameElement.prototype, 'src');
    if(typeof HTMLSourceElement !== 'undefined') hookProp(HTMLSourceElement.prototype, 'src');
    if(typeof HTMLMediaElement !== 'undefined') hookProp(HTMLMediaElement.prototype, 'src');
    if(typeof HTMLAnchorElement !== 'undefined') hookProp(HTMLAnchorElement.prototype, 'href');
    if(typeof HTMLLinkElement !== 'undefined') hookProp(HTMLLinkElement.prototype, 'href');
    if(typeof HTMLFormElement !== 'undefined') hookProp(HTMLFormElement.prototype, 'action');

    document.addEventListener('submit', function(e){
      try{
        var f = e.target;
        if(!f || f.tagName !== 'FORM') return;
        var a = f.getAttribute('action');
        if(!a) return;
        if(a.indexOf('/') === 0 && a.indexOf('//') !== 0) return;
        if(a.indexOf(WORKER) === 0) return;
        f.setAttribute('action', toProxy(a));
      }catch(err){}
    }, true);

    // Keep every navigation on the worker origin: if a link resolves to a
    // different domain, send it through the proxy instead of leaving the app.
    document.addEventListener('click', function(e){
      try{
        var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
        if(!a) return;
        var abs = a.href;
        if(!/^https?:\\/\\//i.test(abs)) return;
        var p = toProxy(abs);
        if(p && p !== abs){ e.preventDefault(); e.stopPropagation(); location.href = p; }
      }catch(err){}
    }, true);

    // ================= TorahAnytime downloader (client-side) =================
    // Sniff HLS playlists the player loads (VDH-style), then let the browser
    // fetch every fMP4 segment and concatenate init + fragments into a valid
    // .mp4 entirely on-device. No server work, no ffmpeg: the stream is CMAF
    // (#EXT-X-MAP init + .m4s), so byte concatenation yields a playable file.
    window.__taHls = window.__taHls || [];
    function recordHls(u){
      try{
        if(typeof u==='string' && /\\.m3u8(\\?|$)/i.test(u)){
          if(window.__taHls.indexOf(u)===-1) window.__taHls.push(u);
        }
      }catch(e){}
    }
    function taMaybeReset(url){
      try{
        if(url==null) return;
        var np=new URL(url, location.href).pathname;
        var oldId=(location.pathname.match(/lectures\\/(\\d+)/)||[])[1];
        var newId=(np.match(/lectures\\/(\\d+)/)||[])[1];
        if(newId && newId!==oldId && window.__taHls) window.__taHls.length=0;
      }catch(e){}
    }
    async function taText(u){ var r=await fetch(u); if(!r.ok) throw new Error('HTTP '+r.status); return await r.text(); }
    async function taBytes(u){ var r=await fetch(u); if(!r.ok) throw new Error('HTTP '+r.status); return new Uint8Array(await r.arrayBuffer()); }
    function taAbs(uri, base){ try{ return new URL(uri, base).href; }catch(e){ return uri; } }
    function taParseMaster(text, base){
      var lines=text.split('\\n'), out=[], pend=null;
      for(var i=0;i<lines.length;i++){ var ln=lines[i].trim();
        if(ln.indexOf('#EXT-X-STREAM-INF')===0){
          var bw=(ln.match(/BANDWIDTH=(\\d+)/)||[])[1];
          var res=(ln.match(/RESOLUTION=([0-9x]+)/)||[])[1];
          pend={bandwidth:parseInt(bw,10)||0,res:res||''};
        } else if(ln && ln.charAt(0)!=='#' && pend){ pend.url=taAbs(ln,base); out.push(pend); pend=null; }
      }
      return out;
    }
    function taParseMedia(text, base){
      var lines=text.split('\\n'), init=null, segs=[];
      for(var i=0;i<lines.length;i++){ var ln=lines[i].trim();
        if(ln.indexOf('#EXT-X-MAP')===0){ var m=ln.match(/URI="([^"]+)"/); if(m) init=taAbs(m[1],base); }
        else if(ln && ln.charAt(0)!=='#'){ segs.push(taAbs(ln,base)); }
      }
      return {init:init, segs:segs};
    }
    async function taResolveSegments(masterUrl){
      var text=await taText(masterUrl), mediaUrl=masterUrl;
      if(/#EXT-X-STREAM-INF/.test(text)){
        var vs=taParseMaster(text, masterUrl);
        vs.sort(function(a,b){return b.bandwidth-a.bandwidth;});
        if(vs.length){ mediaUrl=vs[0].url; text=await taText(mediaUrl); }
      }
      var mm=taParseMedia(text, mediaUrl);
      return (mm.init?[mm.init]:[]).concat(mm.segs);
    }
    // Save straight to the browser's Downloads folder under the given name —
    // no "Save As" dialog (the modal already collected the file name).
    function taSaveBlob(blob, filename){
      var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename; a.rel='noopener';
      document.body.appendChild(a); a.click();
      setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 6000);
    }
    // Load the fMP4/TS -> progressive-MP4 remuxer once, on demand.
    var _taRemuxP=null;
    function taEnsureRemux(){
      if(window.taRxRemux) return Promise.resolve();
      if(_taRemuxP) return _taRemuxP;
      _taRemuxP=new Promise(function(resolve,reject){
        var s=document.createElement('script'); s.src=WORKER+'/__ta__remux.js';
        s.onload=function(){ resolve(); };
        s.onerror=function(){ _taRemuxP=null; reject(new Error('remux load failed')); };
        (document.head||document.documentElement).appendChild(s);
      });
      return _taRemuxP;
    }
    async function taDownloadHls(masterUrl, name, onProg){
      try{ await taEnsureRemux(); }catch(e){ if(window.console) console.warn('[TA-DL]', e); }
      var urls=await taResolveSegments(masterUrl);
      if(!urls.length) throw new Error('no segments found');
      var total=urls.length, done=0, idx=0, CONC=6, buffers=new Array(total);
      function fetcher(){ return (async function(){
        while(idx<total){ var i=idx++; buffers[i]=await taBytes(urls[i]); done++; if(onProg) onProg(done,total); }
      })(); }
      var fs=[]; for(var k=0;k<CONC;k++) fs.push(fetcher());
      await Promise.all(fs);
      // Remux the fMP4 segments into ONE flat, seekable MP4 (single moov + index),
      // instead of a raw concatenation that many players can't scrub.
      if(window.taRxRemux){
        try{
          if(onProg) onProg(total,total,'\\u2699 remuxing to a seekable MP4\\u2026');
          var mp4=window.taRxRemux(null, buffers);
          taSaveBlob(new Blob([mp4], {type:'video/mp4'}), name+'.mp4');
          return true;
        }catch(e){ if(window.console) console.warn('[TA-DL] remux failed, saving raw stream', e); }
      }
      // Fallback: raw concatenation (plays, but may not seek in every player).
      taSaveBlob(new Blob(buffers, {type:'video/mp4'}), name+'.mp4');
      return true;
    }
    function taFilename(){
      var id=(location.pathname.match(/lectures\\/(\\d+)/)||[])[1]||'lecture';
      var t=(document.title||'').replace(/[\\\\/:*?"<>|]+/g,'_').replace(/\\s+/g,' ').trim().slice(0,120);
      return t ? (t+' ['+id+']') : ('torahanytime-'+id);
    }
    // Preferred path: the lecture API exposes a direct progressive MP4 (and MP3).
    // A downloaded progressive MP4 is natively seekable (unlike concatenated
    // fMP4 HLS segments), so this is what the button uses when available.
    async function taFetchMedia(){
      var id=(location.pathname.match(/lectures\\/(\\d+)/)||[])[1];
      if(!id) return null;
      var r=await fetch(toProxy('https://api.torahanytime.com/lectures/'+id));
      if(!r.ok) return null;
      var j=await r.json();
      var mp4=[]; if(j.mp4_url) mp4.push(j.mp4_url); if(j.proxy_mp4_url) mp4.push(j.proxy_mp4_url);
      var mp3=[]; if(j.mp3_url) mp3.push(j.mp3_url); if(j.proxy_mp3_url) mp3.push(j.proxy_mp3_url);
      var m3u8=[]; if(j.proxy_m3u8_url) m3u8.push(j.proxy_m3u8_url); if(j.m3u8_url) m3u8.push(j.m3u8_url);
      return { mp4:mp4, mp3:mp3, m3u8:m3u8, title:j.title||'', duration:j.duration||0,
               vsize:j.video_download_size||0, asize:j.audio_download_size||0 };
    }
    // Read the HLS master and return its variant renditions, highest first.
    async function taFetchVariants(m3u8Cands){
      var text=null, base=null;
      for(var i=0;i<m3u8Cands.length;i++){
        try{ var u=toProxy(m3u8Cands[i]); var t=await taText(u); if(t && /#EXTM3U/.test(t)){ text=t; base=u; break; } }catch(e){}
      }
      if(!text) return [];
      var lines=text.split('\\n'), out=[], pend=null;
      for(var k=0;k<lines.length;k++){ var ln=lines[k].trim();
        if(ln.indexOf('#EXT-X-STREAM-INF')===0){
          var bw=(ln.match(/[:,]BANDWIDTH=(\\d+)/)||[])[1];
          var abw=(ln.match(/AVERAGE-BANDWIDTH=(\\d+)/)||[])[1];
          var res=ln.match(/RESOLUTION=(\\d+)x(\\d+)/)||[];
          pend={ bw:parseInt(bw,10)||0, avgBw:parseInt(abw,10)||0, w:parseInt(res[1],10)||0, h:parseInt(res[2],10)||0 };
        } else if(ln && ln.charAt(0)!=='#' && pend){ pend.url=taAbs(ln, base); out.push(pend); pend=null; }
      }
      return out;
    }
    function taShortRes(h){ return h ? (h+'p') : 'Video'; }
    // Fallback duration: sum the media playlist's #EXTINF segment durations.
    async function taHlsDuration(variantUrl){
      try{ var t=await taText(variantUrl), sum=0, m, re=/#EXTINF:([0-9.]+)/g;
        while((m=re.exec(t))!==null) sum+=parseFloat(m[1])||0;
        return Math.round(sum);
      }catch(e){ return 0; }
    }
    async function taDownloadDirect(candidates, filename, onProg){
      var res=null, lastErr=null;
      for(var i=0;i<candidates.length;i++){
        try{ var r=await fetch(toProxy(candidates[i])); if(r.ok){ res=r; break; } lastErr=new Error('HTTP '+r.status); }catch(e){ lastErr=e; }
      }
      if(!res) throw (lastErr||new Error('media fetch failed'));
      var total=parseInt(res.headers.get('content-length')||'0',10);
      var reader=res.body.getReader(), received=0, x, chunks=[];
      var audio=/\\.mp3$/i.test(filename);
      for(;;){ x=await reader.read(); if(x.done) break; chunks.push(x.value); received+=x.value.length; if(onProg) onProg(received,total); }
      taSaveBlob(new Blob(chunks,{type: audio?'audio/mpeg':'video/mp4'}), filename);
      return true;
    }
    async function taHeadSize(url){
      try{ var r=await fetch(toProxy(url), {method:'HEAD'}); return parseInt(r.headers.get('content-length')||'0',10)||0; }catch(e){ return 0; }
    }
    function taMB(n){ return n ? (n/1048576).toFixed(1)+' MB' : ''; }
    function taSeg(el,on){
      el.style.border='1px solid '+(on?'#6a76ff':'rgba(255,255,255,.12)');
      el.style.background=on?'rgba(91,107,255,.18)':'#0b0e1c';
      el.style.color=on?'#fff':'#aeb6d0';
      el.style.borderRadius='9px'; el.style.padding='9px 13px'; el.style.fontSize='13px';
      el.style.fontWeight='600'; el.style.cursor='pointer';
    }
    function taOpenModal(){
      if(document.getElementById('ta-dl-modal')) return;
      var master=(window.__taHls&&window.__taHls.length)?window.__taHls[0]:null;
      var ov=document.createElement('div'); ov.id='ta-dl-modal';
      ov.setAttribute('style','position:fixed;inset:0;z-index:2147483647;background:rgba(6,8,18,.62);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif');
      ov.innerHTML=
        '<div style="width:min(440px,92vw);background:#12152a;color:#e8eaf0;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:22px;box-shadow:0 30px 80px -20px #000">'+
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">'+
            '<div style="font-size:17px;font-weight:700">Download lecture</div>'+
            '<button id="ta-x" type="button" style="background:none;border:0;color:#8a92b0;font-size:24px;cursor:pointer;line-height:1">&times;</button></div>'+
          '<label style="display:block;font-size:12px;color:#8a92b0;margin:0 0 6px">File name</label>'+
          '<input id="ta-name" style="width:100%;box-sizing:border-box;background:#0b0e1c;border:1px solid rgba(255,255,255,.12);border-radius:9px;color:#fff;padding:10px 12px;font-size:14px;margin-bottom:16px">'+
          '<label style="display:block;font-size:12px;color:#8a92b0;margin:0 0 6px">Quality &amp; size</label>'+
          '<div id="ta-opts" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px"><span style="color:#6a7290;font-size:13px;padding:9px 2px">Loading options\\u2026</span></div>'+
          '<div id="ta-note" style="font-size:11px;color:#6a7290;margin-bottom:16px;line-height:1.5;min-height:14px"></div>'+
          '<div id="ta-prog" style="font-size:12px;color:#8aa0ff;min-height:16px;margin-bottom:12px"></div>'+
          '<div style="display:flex;gap:10px;justify-content:flex-end">'+
            '<button id="ta-cancel" type="button" style="background:rgba(255,255,255,.06);border:0;color:#cfd4e6;border-radius:10px;padding:11px 16px;font-weight:600;cursor:pointer">Cancel</button>'+
            '<button id="ta-go" type="button" style="background:linear-gradient(135deg,#5b6bff,#7c5fff);border:0;color:#fff;border-radius:10px;padding:11px 22px;font-weight:700;cursor:pointer">Download</button></div></div>';
      document.body.appendChild(ov);
      var nameEl=ov.querySelector('#ta-name'); nameEl.value=taFilename();
      var prog=ov.querySelector('#ta-prog'), note=ov.querySelector('#ta-note'), optsWrap=ov.querySelector('#ta-opts');
      var state={ selected:null };
      function close(){ ov.remove(); }
      ov.querySelector('#ta-x').onclick=close; ov.querySelector('#ta-cancel').onclick=close;
      ov.addEventListener('click', function(e){ if(e.target===ov) close(); });
      function setProg(d,t,msg){
        if(msg){ prog.textContent=msg; return; }
        if(t && t<100000){ prog.textContent=Math.round(d/t*100)+'%  ('+d+'/'+t+' segments)'; }
        else if(t){ prog.textContent=Math.round(d/t*100)+'%  '+(d/1048576).toFixed(1)+' / '+(t/1048576).toFixed(1)+' MB'; }
        else { prog.textContent=(d/1048576).toFixed(1)+' MB'; }
      }
      function selectOpt(o){ state.selected=o;
        Array.prototype.forEach.call(optsWrap.children,function(c){ taSeg(c, c.__opt===o); });
        note.textContent = !o ? '' : (o.kind==='hls' ? 'Higher resolution, assembled from the stream on-device.' : (o.kind==='audio' ? 'Audio only.' : 'Direct download \\u2014 fast and fully seekable.'));
      }
      function renderOpts(opts){
        optsWrap.innerHTML='';
        opts.forEach(function(o){
          var b=document.createElement('button'); b.type='button'; b.__opt=o;
          b.textContent=o.label+(o.size?('  \\u00B7  '+(o.approx?'~':'')+taMB(o.size)):'');
          taSeg(b, o===state.selected);
          b.onclick=function(){ selectOpt(o); };
          optsWrap.appendChild(b);
        });
      }
      (async function(){
        var media=await taFetchMedia();
        var duration=media?(media.duration||0):0;
        if(media && media.title) nameEl.value=media.title.replace(/[\\\\/:*?"<>|]+/g,'_').replace(/\\s+/g,' ').trim().slice(0,150);
        var mp4=media?media.mp4:[], mp3=media?media.mp3:[];
        var m3u8=(media&&media.m3u8&&media.m3u8.length)?media.m3u8:(master?[master]:[]);
        var mp4Size=mp4.length?await taHeadSize(mp4[0]):0;
        if(!mp4Size && media && media.vsize) mp4Size=media.vsize;
        var mp3Size=mp3.length?await taHeadSize(mp3[0]):0;
        if(!mp3Size && media && media.asize) mp3Size=media.asize;
        var variants=[]; if(m3u8.length){ try{ variants=await taFetchVariants(m3u8); }catch(e){} }
        variants.sort(function(a,b){ return a.h-b.h; }); // low -> high
        if(!duration && variants.length){ duration=await taHlsDuration(variants[0].url); } // fallback: sum EXTINF
        var opts=[];
        // Lowest resolution first, served by the direct (seekable) MP4 when present.
        if(mp4.length){
          var dh=variants.length?variants[0].h:0;
          opts.push({ label:taShortRes(dh)+' (MP4)', size:mp4Size, kind:'direct', ext:'mp4', source:mp4, fb:variants.length?variants[0].url:null });
        }
        variants.forEach(function(v,i){
          if(mp4.length && i===0) return; // lowest res already covered by the direct MP4
          var est=duration?Math.round((v.avgBw||v.bw)*duration/8):0;
          opts.push({ label:taShortRes(v.h), size:est, approx:true, kind:'hls', ext:'mp4', source:v.url });
        });
        if(!mp4.length && !variants.length && master) opts.push({ label:'Video', size:0, kind:'hls', ext:'mp4', source:master });
        if(mp3.length) opts.push({ label:'Audio (MP3)', size:mp3Size, kind:'audio', ext:'mp3', source:mp3 });
        if(!opts.length){ optsWrap.innerHTML='<span style="color:#e88;font-size:13px;padding:6px 2px">No downloadable media found</span>'; return; }
        state.selected=opts[0]; // default: lowest-res direct download
        renderOpts(opts); selectOpt(opts[0]);
      })();
      ov.querySelector('#ta-go').onclick=async function(){
        if(!state.selected) return;
        var go=ov.querySelector('#ta-go'); go.disabled=true; go.textContent='Downloading\\u2026';
        var nm=((nameEl.value||taFilename()).replace(/[\\\\/:*?"<>|]+/g,'_').trim().slice(0,150))||taFilename();
        var o=state.selected;
        function run(opt){ return opt.kind==='hls' ? taDownloadHls(opt.source, nm, setProg) : taDownloadDirect(opt.source, nm+'.'+opt.ext, setProg); }
        try{
          var ok;
          try{ ok=await run(o); }
          catch(e){
            if(o.kind==='direct' && o.fb){ setProg(0,0,'\\u21BB direct failed \\u2014 assembling stream\\u2026'); ok=await taDownloadHls(o.fb, nm, setProg); }
            else throw e;
          }
          if(ok!==false){ prog.textContent='\\u2713 Saved'; setTimeout(close,1200); }
          else { go.disabled=false; go.textContent='Download'; }
        }catch(e){ prog.textContent='\\u2717 '+((e&&e.message)||e); go.disabled=false; go.textContent='Download'; if(window.console) console.error('[TA-DL]',e); }
      };
    }
    function taOnDownload(){ try{ taOpenModal(); }catch(e){ if(window.console) console.error('[TA-DL]',e); } }
    function taHideGoogleLogin(){
      try{
        var els=document.querySelectorAll('button,a,[role=button]');
        for(var i=0;i<els.length;i++){
          var t=(els[i].innerText||els[i].textContent||'').trim();
          if(t.length<=40 && /(continue|sign\\s?in|log\\s?in|sign\\s?up)\\s+with\\s+google/i.test(t)){
            els[i].style.setProperty('display','none','important');
          }
        }
      }catch(e){}
    }
    function taEnsureUI(){
      try{
        taHideGoogleLogin();
        var hasStream = !!(window.__taHls && window.__taHls.length);
        var onLecture = /\\/lectures\\//.test(location.pathname);
        var show = onLecture || hasStream;
        var btn=document.getElementById('ta-dl-btn');
        if(show && !btn && document.body){
          btn=document.createElement('button'); btn.id='ta-dl-btn'; btn.type='button'; btn.textContent='\\u2B07  Download MP4';
          // Raised above the site's bottom-right chat/save widgets; large pill.
          btn.setAttribute('style','position:fixed;z-index:2147483647;right:20px;bottom:104px;padding:14px 22px;border:0;border-radius:999px;background:linear-gradient(135deg,#5b6bff,#7c5fff);color:#fff;font:700 15px system-ui,-apple-system,sans-serif;cursor:pointer;box-shadow:0 12px 34px -6px rgba(91,107,255,.9);letter-spacing:.2px;transition:transform .12s ease');
          btn.onmouseenter=function(){ btn.style.transform='translateY(-2px)'; };
          btn.onmouseleave=function(){ btn.style.transform='none'; };
          btn.addEventListener('click', taOnDownload);
          document.body.appendChild(btn);
        } else if(!show && btn){ btn.remove(); }
      }catch(e){}
    }
    if(document.readyState!=='loading') taEnsureUI();
    document.addEventListener('DOMContentLoaded', taEnsureUI);
    setInterval(taEnsureUI, 1500);
    // Hide the Google login the instant the modal renders (no interval flash).
    var _taPending=false;
    function taSoon(){ if(_taPending) return; _taPending=true; requestAnimationFrame(function(){ _taPending=false; taHideGoogleLogin(); }); }
    try{ new MutationObserver(taSoon).observe(document.documentElement, {childList:true, subtree:true}); }catch(e){}
  })();</script>`;
}
