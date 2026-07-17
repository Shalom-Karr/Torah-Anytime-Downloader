// Local proxy server for the TorahAnytime downloader.
//
// Standalone:  node server.mjs                 -> http://127.0.0.1:8787
// Tauri sidecar: bundled to one file and spawned with the port as argv[2]
//                (ta-proxy.exe 8787). Binds to loopback only.
//
// Node 18+ (global fetch / Request / Response).

import http from "node:http";
import { handleRequest } from "./proxy.mjs";

// The proxy fetches TorahAnytime over HTTPS. On machines behind a
// TLS-intercepting content filter (e.g. Techloq), the intercepted certificate
// isn't in Node's trust store, so verification would fail EVERY upstream fetch
// ("TypeError: fetch failed"). Accept it — this app only ever talks to
// TorahAnytime and its asset hosts. (Set before any request/fetch is made.)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const PORT = Number(process.argv[2] || process.env.TA_PORT || process.env.PORT) || 8787;
const HOST = "127.0.0.1";

const server = http.createServer(async (req, res) => {
  try {
    const url = `http://${req.headers.host || HOST + ":" + PORT}${req.url}`;

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) v.forEach((vv) => headers.append(k, vv));
      else headers.set(k, v);
    }

    let body;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = Buffer.concat(chunks);
    }

    const request = new Request(url, { method: req.method, headers, body });
    const response = await handleRequest(request);

    res.statusCode = response.status;
    const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie") return; // handled below
      res.setHeader(key, value);
    });
    if (setCookies.length) res.setHeader("set-cookie", setCookies);

    if (response.body) {
      // Stream chunks through as they arrive so large downloads report progress
      // and the server doesn't buffer the whole file in memory.
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise((r) => res.once("drain", r));
        }
      }
      res.end();
    } else {
      res.end();
    }
  } catch (e) {
    res.statusCode = 500;
    res.end("proxy error: " + ((e && e.stack) || e));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`TorahAnytime proxy running at http://${HOST}:${PORT}`);
});
