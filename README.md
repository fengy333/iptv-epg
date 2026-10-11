# github-epg · GitHub Actions 定时预生成 + 静态托管

> 配套的 Workers 实时回源方案在 `../cf-epg/`。

`epg.fanxsc.cyou` 的静态托管方案：**不在请求里实时合并**，而是用 GitHub Actions
定时把上游 EPG 抓下来、合并去重、生成静态文件，再交给静态托管（GitHub Pages / Cloudflare R2）分发。

播放器拿到的永远是一份**已经生成好的、完整且稳定的文件**，彻底绕开
Cloudflare Workers 免费版 10ms CPU 上限导致的「响应被截断」。

数据来源：[github.com/taksssss/tv](https://github.com/taksssss/tv)

---

## 为什么需要这个方案

Workers 方案的 `/epg/lite.xml`、`/epg/all.xml` 时好时坏，根因有两个：

1. **CPU 超限**：免费版每请求只有 10ms CPU，合并 8 源 77MB 必然超限，
   表现为响应在随机位置被截断，或直接 `Error 1102`。
2. **重复 channel id**：上游 `51zmt` 与 `51zmte1` 的频道 id 都是 `1..100`，
   直接首尾拼接会让播放器串台、或解析失败——**症状正是「EPG 能加载但没有节目单」**。

预生成方案把重活挪到 CI（GitHub Actions 免费、CPU 充足，实测一次 12 秒），
线上只剩静态文件分发：没有 CPU 限制、没有冷启动、没有中途截断；
同时脚本会做 **channel id 去重**（实测全量会去掉 181 个重复 id），保证播放器能正确映射。

---

## 快速开始（3 步）

1. 把本目录推成一个 **公开** GitHub 仓库（公开仓库才能免费用 Pages）
2. 仓库 `Settings → Pages → Source` 选 **GitHub Actions**
3. 仓库 `Actions → Build EPG → Run workflow` 手动跑一次

跑完在 Pages 上得到类似地址：

```
https://<你的用户名>.github.io/<仓库名>/epg/lite.xml
```

之后 workflow 每 6 小时自动重建一次（北京时间 02:07 / 08:07 / 14:07 / 20:07）。

> 换域名时，播放器里只需改域名，**路径 `/epg/xxx.xml` 完全一致**（产物刻意对齐了 Worker 的路径结构）。

---

## 产物

| 文件 | 源 | 未压缩 | gzip | 频道 | 节目 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| `epg/mini.xml` | 2 源 | 7.1 MB | **0.9 MB** | 826 | 27,941 | 最省事，央视/卫视够用 |
| `epg/lite.xml` | 3 源 | 13.1 MB | **1.2 MB** | 1,536 | 52,989 | **推荐**，覆盖大陆频道 |
| `epg/all.xml` | 8 源 | 77.4 MB | **6.4 MB** | 2,942 | 313,205 | 全量，含中国港澳台 |
| `epg/<源名>.xml` | 单源 | — | — | — | — | 8 个源的原始快照 |

真正的下载体积看 gzip 那一列（静态托管/CDN 会自动按 `Accept-Encoding: gzip` 传输压缩）。
`dist/index.html` 是构建时自动生成的订阅导航页。

选源说明：

| 源 | channel id 形态 | 说明 |
| --- | --- | --- |
| `112114` | 频道名（`CCTV1`、`湖南卫视`） | 大陆主流 |
| `51zmte1` | 数字 `1..1030` | 含 `51zmt` 全部频道，是其超集 |
| `epgpw_cn` | 6 位数字 | 大陆，量大 |
| `erw` / `epgpw_hk` / `epgpw_tw` | 各自独立 | 港台与聚合源（体积大） |

`51zmt` 与 `51zmte1` id 冲突、`51zmte2` 与 `51zmte1` 部分冲突——脚本会自动去重，不会让播放器出错。

---

## 播放器接入（酷9 等必读）

1. 添加 EPG 地址后，**点一下这个地址**，把「解析格式」改成 **XmlTV**。
   酷9 默认是 **DIYP** 解析，不改成 XmlTV 就一个节目都加载不出来。
2. 填入（示例）：`https://<你的用户名>.github.io/<仓库名>/epg/lite.xml`
3. 如果之前填过旧地址，**先删掉再重新添加**，否则会命中 `epgCache` 里的旧失败缓存。

---

## 可选：同步到 Cloudflare R2（国内访问更稳）

`*.github.io` 在国内经常不可达或很慢。若你已有 Cloudflare 账号，
可以把产物同步到 R2 并绑定自己的域名（R2 出网流量免费，很适合这种大文件）。

**第一步**，在仓库 `Settings → Secrets and variables → Actions` 配置：

| 类型 | 名称 | 值 |
| --- | --- | --- |
| Secret | `CF_API_TOKEN` | Cloudflare API Token，权限：Account → Workers R2 Storage → Edit |
| Secret | `CF_ACCOUNT_ID` | Cloudflare 账户 ID |
| Variable | `R2_BUCKET` | 桶名，例如 `epg` |
| Variable | `EPG_SITE` | 最终访问地址，例如 `https://static.fanxsc.cyou` |
| Variable | `R2_PREFIX` | 可选，对象前缀，默认 `epg` |

配好后 workflow 会自动多跑一步「同步到 Cloudflare R2」；没配则自动跳过，只发布 Pages。

**第二步**，在 Cloudflare 侧：新建 R2 桶 → 给桶绑定自定义域（例如 `static.fanxsc.cyou`）→ 开启公共访问。

之后的订阅地址就是：

```
https://static.fanxsc.cyou/epg/lite.xml
```

> 想直接复用 `epg.fanxsc.cyou`：需要在 Cloudflare 把该域名的 Worker 自定义域解除，
> 再把它绑到 R2 桶上（或用 CNAME 指向 R2 域名）。建议先用新子域跑通再说，
> 这样方案一（Worker）可以同时保留在 `epg.fanxsc.cyou`。

---

## 本地构建 / 预览

```bash
# 全量三档
node scripts/build-epg.mjs --out dist

# 只生成某一档
node scripts/build-epg.mjs --out dist --groups lite

# 国内网络建议指定 gitee 镜像（jsDelivr / GitHub raw 可能不通）
EPG_MIRRORS=https://gitee.com/taksssss/tv/raw/main node scripts/build-epg.mjs --out dist

# 校验产物（XML 合法性 / id 去重 / programme 引用完整）
python3 scripts/verify.py dist/epg/mini.xml dist/epg/lite.xml dist/epg/all.xml

# 本地起个静态服务器实测（模拟 CDN 的 gzip 传输）
node scripts/serve.mjs dist          # http://127.0.0.1:8787
```

镜像默认顺序：`raw.githubusercontent.com` → `cdn.jsdelivr.net` → `gitee.com`（逐个回退）。

---

## 本方案相关文件

```
.github/workflows/build-epg.yml   # 定时构建 + 发布 Pages（+ 可选 R2）
scripts/
├── build-epg.mjs                 # 下载 / 合并 / 去重 / 输出（零依赖）
├── verify.py                     # 产物校验
└── serve.mjs                     # 本地预览服务器
package.json / .gitignore
```

## 常用配置（仓库 Variables）

| Variable | 作用 |
| --- | --- |
| `EPG_SITE` | 写进 XML 与首页的站点地址 |
| `R2_BUCKET` / `R2_PREFIX` | 启用 R2 同步 |
| `ENABLE_PAGES` | 设为 `false` 则跳过 GitHub Pages 部署（只用 R2 时） |
| `KEEPALIVE` | 设为 `false` 则关闭保活提交 |
| `EPG_MIRRORS` | 自定义镜像顺序（逗号分隔） |

---

## 常见问题

**Q：仓库会被 77MB 的文件撑爆吗？**
不会。产物走 Pages artifact 发布，**不进 git 历史**（`dist/` 已在 `.gitignore`）。

**Q：GitHub Pages 有什么限制？**
单文件 100MB、站点 1GB、带宽软限制 100GB/月。`all.xml` 77MB 在单文件限制内，
但仍建议播放器优先用 `lite.xml`（传输约 1.2MB）。

**Q：定时任务不跑了？**
新建仓库的 schedule 需要先手动 `Run workflow` 一次激活；
另外 GitHub 会在仓库 60 天无提交活动后停用定时工作流，本仓库用「保活提交」规避
（不需要可把 Variable `KEEPALIVE` 设为 `false`）。

**Q：想增删源或调整组合？**
改 `scripts/build-epg.mjs` 顶部的 `SOURCES` 与 `GROUPS`，提交后 workflow 会自动重建。

**Q：`all.xml` 用不了 / 播放器卡？**
77MB 对很多电视盒子的内存和解析速度是负担，优先用 `lite.xml` 或 `mini.xml`。
