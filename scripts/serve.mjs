#!/usr/bin/env node
/**
 * 本地预览服务器（零依赖）—— 模拟静态托管的行为，方便用酷9等播放器实测。
 *
 *   node scripts/serve.mjs                 # 预览 dist/，http://127.0.0.1:8787
 *   node scripts/serve.mjs dist-test 9000  # 指定目录与端口
 *   HOST=0.0.0.0 node scripts/serve.mjs    # 让同局域网手机/电视也能访问（自行判断风险）
 *
 * 关键行为：对 .xml 请求，若客户端声明 Accept-Encoding: gzip 且存在同名 .gz，
 * 直接回 gz + Content-Encoding: gzip —— 与 GitHub Pages / CDN 的传输压缩一致，
 * 这样本地测出的体积/耗时就和线上一致。
 */
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] || "dist");
const port = Number(process.argv[3] || process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";

const TYPES = {
  ".xml": "application/xml; charset=utf-8",
  ".gz": "application/gzip",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end("method not allowed");
    return;
  }
  const url = new URL(req.url, "http://localhost");
  let p = decodeURIComponent(url.pathname);
  if (p === "/") p = "/index.html";

  const file = path.join(root, p);
  const rel = path.relative(root, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end(`404 ${p}`);
    return;
  }

  const acceptGz = String(req.headers["accept-encoding"] || "").includes("gzip");
  if (acceptGz && file.endsWith(".xml") && existsSync(file + ".gz")) {
    const st = statSync(file + ".gz");
    console.log(`200(gzip) ${p}  ${(st.size / 1048576).toFixed(2)}MB`);
    res.writeHead(200, {
      "content-type": "application/xml; charset=utf-8",
      "content-encoding": "gzip",
      "content-length": st.size,
      vary: "Accept-Encoding",
      "cache-control": "no-cache",
    });
    if (req.method === "HEAD") return res.end();
    createReadStream(file + ".gz").pipe(res);
    return;
  }

  const st = statSync(file);
  console.log(`200        ${p}  ${(st.size / 1048576).toFixed(2)}MB`);
  res.writeHead(200, {
    "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
    "content-length": st.size,
    "cache-control": "no-cache",
  });
  if (req.method === "HEAD") return res.end();
  createReadStream(file).pipe(res);
}).listen(port, host, () => {
  console.log(`本地预览：http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}/`);
  console.log(`静态目录：${root}`);
  console.log("按 Ctrl+C 结束");
});
