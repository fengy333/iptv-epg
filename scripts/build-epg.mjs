#!/usr/bin/env node
/**
 * EPG 预生成脚本（GitHub Actions / 本地均可运行，零第三方依赖）
 * ---------------------------------------------------------------
 * 做三件事：
 *   1. 从上游镜像下载 taksssss/tv 的全部 EPG 源（.xml.gz）；
 *   2. 合并成若干「套餐」文件，并做 channel id 去重（避免播放器串台/无节目单）；
 *   3. 输出到 dist/：合并文件 + 单源文件 + .gz 预压缩 + index.html + status.json。
 *
 * 产物直接丢给静态托管（GitHub Pages / Cloudflare Pages / R2 / 任意 OSS），
 * 播放器拿到的就是一份**已经生成好的、完整且稳定的静态文件**，
 * 彻底绕开 Cloudflare Workers 免费版 10ms CPU 上限导致的「响应被截断」。
 *
 * 用法：
 *   node scripts/build-epg.mjs --out dist
 *   node scripts/build-epg.mjs --out dist --groups lite        # 只生成某几档
 *   EPG_MIRRORS=https://gitee.com/taksssss/tv/raw/main node scripts/build-epg.mjs
 */

import { createWriteStream, createReadStream, mkdirSync, writeFileSync, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGzip, gunzipSync, gzip } from "node:zlib";
import path from "node:path";

// 站点前缀（写进 XML 的 generator-info-url 与首页示例）
const SITE = process.env.EPG_SITE || "https://epg.fanxsc.cyou";

// ---------------- 配置 ----------------

// 上游镜像，按顺序尝试。Actions 里 raw.githubusercontent 最快；
// 国内本地跑建议用 EPG_MIRRORS 指定 gitee。
const DEFAULT_MIRRORS = [
  "https://raw.githubusercontent.com/taksssss/tv/main",
  "https://cdn.jsdelivr.net/gh/taksssss/tv@main",
  "https://gitee.com/taksssss/tv/raw/main",
];

const SOURCES = [
  { name: "112114", note: "epg.112114.xyz（id=频道名）" },
  { name: "51zmt", note: "epg.51zmt.top（id=1..100）" },
  { name: "51zmte1", note: "epg.51zmt.top:8000（id=1..1030，51zmt 超集）" },
  { name: "51zmte2", note: "epg.51zmt.top:8000（id=1..1030）" },
  { name: "erw", note: "erw 聚合源" },
  { name: "epgpw_cn", note: "epg.pw 大陆（id=6 位数字）" },
  { name: "epgpw_hk", note: "epg.pw 中国香港" },
  { name: "epgpw_tw", note: "epg.pw 中国台湾" },
];

// 合并套餐。选源原则：尽量选 channel id 编号空间互不重叠的源；
// 脚本自带去重，即使重叠也不会让播放器解析失败。
const GROUPS = [
  {
    name: "mini",
    title: "极简（2 源 · 央视/卫视为主）",
    sources: ["112114", "51zmte1"],
  },
  {
    name: "lite",
    title: "精简（3 源 · 大陆频道，推荐）",
    sources: ["112114", "51zmte1", "epgpw_cn"],
  },
  {
    name: "all",
    title: "全量（8 源 · 含中国港澳台，体积大）",
    sources: SOURCES.map((s) => s.name),
  },
];

// ---------------- 参数 ----------------

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const OUT = path.resolve(arg("out", "dist"));
// 订阅文件统一放在 epg/ 子目录 —— 与 https://epg.fanxsc.cyou/epg/xxx.xml 的路径对齐，
// 这样换到 GitHub Pages / R2 自定义域后，播放器里的地址只需改域名。
const EPG_DIR = path.join(OUT, "epg");
const onlyGroups = arg("groups", "").split(",").map((s) => s.trim()).filter(Boolean);
const GROUPS_USED = onlyGroups.length ? GROUPS.filter((g) => onlyGroups.includes(g.name)) : GROUPS;
const MIRRORS = (process.env.EPG_MIRRORS || "").split(",").map((s) => s.trim()).filter(Boolean);
if (!MIRRORS.length) MIRRORS.push(...DEFAULT_MIRRORS);

// 只下载被用到的源
const NEEDED = new Set(GROUPS_USED.flatMap((g) => g.sources));

// ---------------- 工具 ----------------

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const cnNow = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
const cnStamp = () => cnNow().replace(/[-: ]/g, "");
const mb = (n) => (n / 1048576).toFixed(2) + "MB";

// 带缓冲的按行写入器（避免几十万次小 write）
class LineSink {
  constructor(file) {
    this.file = file;
    this.stream = createWriteStream(file);
    this.buf = [];
    this.pending = 0;
    this.bytes = 0;
  }
  line(s) {
    this.buf.push(s, "\n");
    this.pending += s.length + 1;
    if (this.pending >= 65536) this.flush();
  }
  flush() {
    if (!this.buf.length) return;
    const s = this.buf.join("");
    this.bytes += Buffer.byteLength(s);
    this.stream.write(s);
    this.buf = [];
    this.pending = 0;
  }
  end() {
    this.flush();
    return new Promise((res, rej) => this.stream.end((e) => (e ? rej(e) : res())));
  }
}

async function fetchWithRetry(url, tries = 2) {
  let lastErr = "unknown";
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { "user-agent": "epg-build/1.0 (+github-actions)", "accept-encoding": "identity" },
        signal: AbortSignal.timeout(120000),
      });
      if (r.ok) return r;
      lastErr = `HTTP ${r.status}`;
    } catch (e) {
      lastErr = String((e && e.message) || e);
    }
    await new Promise((r) => setTimeout(r, 800 * (i + 1)));
  }
  throw new Error(lastErr);
}

async function download(name) {
  const p = `/epg/${encodeURIComponent(name)}.xml.gz`;
  const errs = [];
  for (const base of MIRRORS) {
    try {
      const r = await fetchWithRetry(base + p);
      const buf = Buffer.from(await r.arrayBuffer());
      let text;
      let gz;
      if (buf[0] === 0x1f && buf[1] === 0x8b) {
        gz = buf;
        text = gunzipSync(buf).toString("utf8");
      } else {
        text = buf.toString("utf8");
        if (!text.includes("<tv")) throw new Error("响应不是 XMLTV");
        gz = await gzipBuffer(buf);
      }
      return { ok: true, text, gz, mirror: new URL(base).host };
    } catch (e) {
      errs.push(`${new URL(base).host}: ${String((e && e.message) || e)}`);
    }
  }
  return { ok: false, errors: errs };
}

function gzipBuffer(buf) {
  return new Promise((res, rej) => gzip(buf, { level: 9 }, (e, o) => (e ? rej(e) : res(o))));
}

const RE_CHANNEL_ID = /<channel\s+id="([^"]*)"/g;
const RE_PROG_CH = /<programme\b[^>]*\bchannel="([^"]*)"/;

function channelIdsOf(text) {
  const ids = [];
  RE_CHANNEL_ID.lastIndex = 0;
  let m;
  while ((m = RE_CHANNEL_ID.exec(text))) ids.push(m[1]);
  return ids;
}

// ---------------- 合并核心 ----------------

function openGroup(st) {
  st.sink.line(`<?xml version="1.0" encoding="UTF-8"?>`);
  st.sink.line(`<!DOCTYPE tv SYSTEM "xmltv.dtd">`);
  st.sink.line(
    `<tv date="${cnStamp()} +0800" generator-info-name="fanxsc-epg" generator-info-url="${SITE}" ` +
      `source-info-name="taksssss/tv merged-${st.def.name}">`
  );
}

function feedSource(st, srcName, text, ids) {
  if (!st.started) {
    openGroup(st);
    st.started = true;
  }
  st.sink.line(`<!-- src:${srcName} -->`);

  // 该源里被接受（全局首次出现）的 channel id
  const accepted = new Set();
  for (const id of ids) {
    if (!st.seen.has(id)) {
      st.seen.add(id);
      accepted.add(id);
    } else {
      st.dup++;
    }
  }

  let mode = null; // { type: "channel"|"programme", keep: boolean }
  for (const raw of text.split("\n")) {
    const t = raw.trim();
    if (!t) continue;

    if (mode) {
      if (mode.keep) st.sink.line(raw);
      // 注意：块内可能含 <icon src="..."/> 这类自闭合子元素，
      // 只有真正的结束标签才算块结束（不能用 endsWith("/>") 判断）。
      if (mode.type === "channel") {
        if (t.startsWith("</channel>")) mode = null;
      } else if (t.startsWith("</programme>")) {
        mode = null;
      }
      continue;
    }

    if (t.startsWith("<channel")) {
      const id = (/<channel\s+id="([^"]*)"/.exec(t) || [])[1];
      const keep = accepted.has(id);
      if (keep) {
        st.sink.line(raw);
        st.ch++;
      }
      mode = t.includes("</channel>") || t.endsWith("/>") ? null : { type: "channel", keep };
    } else if (t.startsWith("<programme")) {
      const chId = (RE_PROG_CH.exec(t) || [])[1];
      const keep = accepted.has(chId);
      if (keep) {
        st.sink.line(raw);
        st.pg++;
      }
      mode = t.includes("</programme>") || t.endsWith("/>") ? null : { type: "programme", keep };
    }
    // 其余行（<?xml / <!DOCTYPE / <tv / </tv / 注释）丢弃，由本脚本自己写头尾
  }

  st.sink.line(`<!-- /src:${srcName} -->`);
  st.used.push(srcName);
}

// ---------------- 主流程 ----------------

async function main() {
  mkdirSync(EPG_DIR, { recursive: true });
  log(`输出目录：${OUT}`);
  log(`镜像顺序：${MIRRORS.join("  →  ")}`);
  log(`套餐：${GROUPS_USED.map((g) => `${g.name}(${g.sources.length}源)`).join(", ")}`);

  const states = new Map();
  for (const def of GROUPS_USED) {
    states.set(def.name, {
      def,
      seen: new Set(),
      sink: new LineSink(path.join(EPG_DIR, `${def.name}.xml`)),
      started: false,
      ch: 0,
      pg: 0,
      dup: 0,
      used: [],
    });
  }

  const status = { built_at: cnNow(), built_at_utc: new Date().toISOString(), sources: {}, groups: {}, files: [] };

  for (const s of SOURCES) {
    if (!NEEDED.has(s.name)) continue;
    log(`↓ 下载 ${s.name} …`);
    const dl = await download(s.name);
    if (!dl.ok) {
      log(`✗ ${s.name} 全部镜像失败：${dl.errors.join(" | ")}`);
      status.sources[s.name] = { ok: false, errors: dl.errors };
      continue;
    }
    log(`✓ ${s.name} ← ${dl.mirror}  ${mb(dl.text.length)}（gz ${mb(dl.gz.length)}）`);

    // 单源文件（原样保真：解压版 + 上游 gz）
    writeFileSync(path.join(EPG_DIR, `${s.name}.xml`), dl.text);
    writeFileSync(path.join(EPG_DIR, `${s.name}.xml.gz`), dl.gz);

    const ids = channelIdsOf(dl.text);
    for (const st of states.values()) {
      if (st.def.sources.includes(s.name)) feedSource(st, s.name, dl.text, ids);
    }

    status.sources[s.name] = {
      ok: true,
      mirror: dl.mirror,
      note: s.note,
      channels_in_source: ids.length,
      bytes: dl.text.length,
      gz_bytes: dl.gz.length,
    };
  }

  // 收尾：写 </tv>、生成 .gz、统计
  for (const st of states.values()) {
    if (!st.started) {
      openGroup(st);
      st.started = true;
    }
    st.sink.line(`</tv>`);
    await st.sink.end();

    const xmlPath = path.join(EPG_DIR, `${st.def.name}.xml`);
    const gzPath = `${xmlPath}.gz`;
    await pipeline(createReadStream(xmlPath), createGzip({ level: 9 }), createWriteStream(gzPath));

    const size = statSync(xmlPath).size;
    const gzSize = statSync(gzPath).size;
    status.groups[st.def.name] = {
      title: st.def.title,
      sources: st.used,
      channels: st.ch,
      programmes: st.pg,
      duplicate_channel_ids_skipped: st.dup,
      bytes: size,
      gz_bytes: gzSize,
    };
    log(`✔ ${st.def.name}.xml  ${mb(size)}（gz ${mb(gzSize)}）  频道 ${st.ch} / 节目 ${st.pg}  去重 ${st.dup}`);
  }

  // 单源文件也补一份 gz 的体积记录
  for (const s of SOURCES) {
    const rec = status.sources[s.name];
    if (rec && rec.ok) {
      status.files.push({ file: `${s.name}.xml`, bytes: rec.bytes });
      status.files.push({ file: `${s.name}.xml.gz`, bytes: rec.gz_bytes });
    }
  }
  for (const [k, v] of Object.entries(status.groups)) {
    status.files.push({ file: `${k}.xml`, bytes: v.bytes, gz_bytes: v.gz_bytes });
  }

  writeFileSync(path.join(OUT, "status.json"), JSON.stringify(status, null, 2));
  writeFileSync(path.join(OUT, ".nojekyll"), "");
  writeFileSync(path.join(OUT, "index.html"), renderIndex(status));

  log(`✅ 完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// ---------------- 静态首页 ----------------

function renderIndex(status) {
  const origin = SITE;
  const g = status.groups;
  const rows = Object.entries(g)
    .map(([k, v]) => {
      const isBig = v.bytes > 25 * 1048576;
      return `<tr>
      <td><b>${k}.xml</b><span class="m">${v.title}</span><span class="m">${v.sources.join(" + ")}</span></td>
      <td class="n">${(v.bytes / 1048576).toFixed(1)}MB<em>gz ${(v.gz_bytes / 1048576).toFixed(1)}MB</em></td>
      <td class="n">${v.channels}<em>${v.programmes} 条节目</em></td>
      <td class="a">
        <a href="./epg/${k}.xml">.xml</a>
        <a href="./epg/${k}.xml.gz">.xml.gz</a>
        ${isBig ? '<span class="warn">体积偏大，播放器可能卡</span>' : ""}
      </td>
    </tr>`;
    })
    .join("");

  const single = Object.keys(status.sources)
    .filter((k) => status.sources[k].ok)
    .map(
      (k) => `<li><b>${k}</b> <span class="m">${status.sources[k].note || ""}</span>
      <a href="./epg/${k}.xml">.xml</a><a href="./epg/${k}.xml.gz">.xml.gz</a>
      <span class="m">${(status.sources[k].bytes / 1048576).toFixed(2)}MB / ${status.sources[k].channels_in_source} 频道</span></li>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>EPG 静态订阅 · ${origin.replace(/^https?:\/\//, "")}</title>
<style>
 :root{--bg:#f6f7f9;--panel:#fff;--bd:#e4e7ec;--tx:#1d2433;--mu:#667085;--ac:#2563eb;--soft:#eef4ff}
 *{box-sizing:border-box}
 body{margin:0;padding:32px 20px 64px;background:var(--bg);color:var(--tx);font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
 .w{max-width:900px;margin:0 auto}
 h1{font-size:23px;margin:0 0 6px}
 .sub{color:var(--mu);margin:0 0 20px}
 .card{background:var(--panel);border:1px solid var(--bd);border-radius:12px;padding:20px;margin-bottom:18px}
 h2{font-size:15px;margin:0 0 14px}
 table{width:100%;border-collapse:collapse}
 th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--bd);vertical-align:top}
 th{font-size:12px;color:var(--mu);text-transform:uppercase;letter-spacing:.4px}
 tr:last-child td{border-bottom:none}
 td.n{white-space:nowrap;font-variant-numeric:tabular-nums}
 td.n em,.m{display:block;font-style:normal;font-size:12px;color:var(--mu)}
 .a a{display:inline-block;margin:0 6px 4px 0;padding:3px 10px;border-radius:6px;background:var(--soft);color:var(--ac);text-decoration:none;font-size:12px;border:1px solid #d6e2ff}
 .warn{display:block;font-size:12px;color:#b54708}
 pre{background:#0f172a08;border:1px solid var(--bd);border-radius:8px;padding:14px;overflow-x:auto;font:12.5px/1.7 ui-monospace,Consolas,monospace;margin:0}
 ul{margin:0;padding-left:18px}li{margin:6px 0}
 .tag{display:inline-block;padding:2px 8px;border-radius:999px;background:var(--soft);color:var(--ac);font-size:12px;border:1px solid #d6e2ff;margin-right:6px}
 footer{color:var(--mu);font-size:12px;text-align:center;margin-top:22px}
</style></head><body><div class="w">
<h1>EPG 静态订阅</h1>
<p class="sub"><span class="tag">GitHub Actions 定时预生成</span><span class="tag">静态托管 · 无 CPU 限流</span>构建于 ${status.built_at}（北京时间）</p>

<div class="card"><h2>合并订阅（推荐）</h2>
<table><tr><th>文件</th><th>体积</th><th>频道 / 节目</th><th>下载</th></tr>${rows}</table>
<p style="margin:12px 0 0;font-size:12.5px;color:var(--mu)">
<b>酷9 必看</b>：添加地址后<b>点一下该地址</b>，把「解析格式」改成 <b>XmlTV</b>（默认 DIYP 会一个节目都读不出来）。
</p></div>

<div class="card"><h2>单源订阅</h2><ul>${single}</ul></div>

<div class="card"><h2>订阅示例</h2><pre># 精简（3 源 · 大陆）
${origin}/epg/lite.xml
# 极简（2 源 · 央视/卫视）
${origin}/epg/mini.xml
# 全量（8 源 · 含中国港澳台，体积大）
${origin}/epg/all.xml</pre></div>

<footer>数据来源 <a href="https://github.com/taksssss/tv">taksssss/tv</a> · 本页为构建产物，勿手改</footer>
</div></body></html>`;
}

main().catch((e) => {
  console.error("构建失败：", e);
  process.exit(1);
});
