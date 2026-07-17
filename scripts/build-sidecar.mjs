// Build the Node sidecar for the Tauri app.
//
// 1) esbuild bundles server.mjs + proxy.mjs into one CommonJS file
//    (src-tauri/sidecar/server.cjs), shipped as a Tauri resource.
// 2) The current node.exe is copied to src-tauri/binaries/ta-proxy-<triple>.exe,
//    which Tauri bundles as the "ta-proxy" sidecar. At runtime the Rust shell
//    runs:  ta-proxy.exe <resourceDir>/server.cjs <port>
//
// This avoids re-implementing the proxy in Rust and keeps the exact, tested JS.
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execPath } from "node:process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const binDir = join(root, "src-tauri", "binaries");
const resDir = join(root, "src-tauri", "sidecar");
mkdirSync(binDir, { recursive: true });
mkdirSync(resDir, { recursive: true });

// 1) bundle server.mjs (imports proxy.mjs) -> single CJS
const outCjs = join(resDir, "server.cjs");
execSync(
  `npx esbuild "${join(root, "server.mjs")}" --bundle --platform=node --format=cjs --target=node18 --outfile="${outCjs}"`,
  { stdio: "inherit", cwd: root }
);
console.log("bundled sidecar ->", outCjs);

// 2) copy the Node runtime as the sidecar binary (Windows x64 target triple)
const triple = "x86_64-pc-windows-msvc";
const sidecarExe = join(binDir, `ta-proxy-${triple}.exe`);
copyFileSync(execPath, sidecarExe);
console.log("sidecar runtime ->", sidecarExe);
console.log("done");
