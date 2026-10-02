# R2 增强管理

部署到 Cloudflare Pages 的 R2 文件管理站。**网站只需部署一次，所有连接信息在网页里填写**——R2 的 Access Key、Secret、Endpoint、Bucket 都不写进代码，而是保存在你浏览器的 `localStorage` 中。

任何人 fork / 部署本项目都会得到同一个静态站点，各自填入自己的 R2 配置，互不干扰，也不需要向 Cloudflare 平台写入任何 Secrets。

## 为什么这样设计

同类项目（如 CloudFlare-R2-Filesystem）需要在部署时通过 KV / R2 绑定或环境变量把配置写进平台。本项目反其道而行：

- 整个前端是**纯静态资源**，`public/` 目录下没有构建步骤；
- 浏览器**直连 R2 的 S3 API**，请求签名（AWS Signature V4）在客户端完成，本站点不做任何代理；
- 连接信息只存在访问者的本地浏览器里，部署产物中不含任何凭据；
- 因此**没有服务端**，也就没有服务端凭据泄露面，站点可以公开部署。

代价是必须在 R2 侧开启 CORS（见下文），且客户端能看到密钥。这是「部署零配置」换来的合理取舍，详见[安全性说明](#安全性说明)。

## 快速开始

### 1. 创建 R2 存储桶与 API 令牌

在 [Cloudflare 控制台](https://dash.cloudflare.com)：

1. 左侧 **Storage & Databases → R2 object storage** → **Create bucket**，记下桶名。
2. **R2 object storage → Manage R2 API Tokens → Create API Token**，记下这两个值：
   - **Access Key ID**（令牌 ID）
   - **Secret Access Key**（机密访问密钥）
3. 在 **R2 object storage → Settings**（或 Manage R2 API Tokens 页）找到
   **S3 API** 一栏的 **Endpoint**，形如 `https://<account-id>.r2.cloudflarestorage.com`。
   这就是配置页里的「为 S3 客户端使用管辖权地特定的终结点」。
4. 可选：**Bucket → Settings → Public bucket access** 可以拿到
   **R2 Public Development URL**（`https://pub-xxx.r2.dev`），
   或自行绑定**自定义域**。填了之后才能生成可直接分享的公开链接。

### 2. 配置 CORS（必做，否则浏览器请求会被拒）

浏览器直连 S3 API 必须有 CORS 规则。在 **Bucket → Settings → Public bucket access → CORS**：

- **Allowed Origins**：你的站点地址，例如 `https://<你的项目名>.pages.dev`
  （建议同时加上 `https://<你的项目名>.githubpreview.dev` 以便预览测试）
- **Allowed Methods**：`GET`、`HEAD`、`PUT`、`POST`、`DELETE`
- **Allowed Headers**：`*`（**必须填写**，否则 `Authorization` 等签名头会被浏览器预检拦截）
- **Exposed Headers**：`x-amz-meta-*`、`Content-Length`、`Last-Modified`、`ETag`
- **Max Age**：`3600`

> ⚠️ **两个最常见的 CORS 配置错误**：
> 1. `AllowedOrigins` 末尾带了斜杠（如 `https://a.pages.dev/`）——浏览器发送的 `Origin` 头**不带斜杠**，CORS 是精确字符串匹配，带斜杠必然失败；
> 2. 漏填 `AllowedHeaders: ["*"]`——本站请求带 `Authorization`、`x-amz-date`、`x-amz-content-sha256` 等自定义头，没有 `AllowedHeaders` 时预检（OPTIONS）会被拒绝。
> 正确的 `AllowedOrigins` 就是浏览器地址栏里"当前站点"的 origin（`location.origin`），配置页的 CORS 提示里会显示它，可原样复制。

也可以直接用 R2 的 CORS API 配置（把域名换成你的，账户 ID 换成你的）：

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/r2/buckets/<BUCKET>/cors" \
  -H "Authorization: Bearer <YOUR_CLOUDFLARE_API_TOKEN>" \
  -H "Content-Type: application/json" \
  --data '{
    "cors": {
      "CORSRules": [{
        "AllowedHeaders": ["*"],
        "AllowedMethods": ["GET", "HEAD", "PUT", "POST", "DELETE"],
        "AllowedOrigins": ["https://<你的项目名>.pages.dev"],
        "ExposeHeaders": ["x-amz-meta-*", "Content-Length", "Last-Modified", "ETag"],
        "MaxAgeSeconds": 3600
      }]
    }
  }'
```

> API Token 需要 `R2 Object Storage - Edit` 权限。字段以 Cloudflare 官方文档为准。

### 3. 部署

**方式 A：Cloudflare Pages Git 自动部署（推荐）**

1. 把本项目推送到你的 GitHub 仓库。
2. 在 Cloudflare 控制台 **Workers & Pages → Create → Pages → Connect to Git**，选择该仓库。
3. 构建配置里：
   - Build command 留空
   - Build output directory 填 `public`
   - Production branch 选 `main`
   - 环境变量**不用填**
4. 保存后 Cloudflare 会拉取仓库自动构建部署；之后每次推送到 `main` 自动更新生产域名，其他分支生成预览版本。

> - **部署由 Cloudflare 侧的 Git 集成完成**。仓库里的 GitHub Actions（`.github/workflows/ci.yml`）只负责跑测试守门，
>   测试不通过会在 GitHub 上标红提醒，但不会阻止 Cloudflare 部署。
> - 如果现有 Pages 项目是 wrangler 直传（Direct Upload）创建的，无法直接绑定 Git，
>   需要用 Connect to Git 新建一个 Pages 项目（域名会变，可在自定义域里绑回原域名）。

**方式 B：本地 wrangler 部署**（不想连 Git 时手动发布）

```bash
npx wrangler pages deploy public
```

### 4. 首次使用

打开部署好的站点：

1. 页面会直接进入**配置页**，填入第 1 步记下的 Access Key ID / Secret Access Key / Endpoint / Bucket；
   `R2 公共开发 URL` 和 `自定义域` 可选。
2. 点**测试连接**确认无误，再点**保存并连接**。
3. 进入文件管理界面。

之后配置保存在本机浏览器中，下次打开自动恢复。需要管理多个桶时，
可以保存多条配置并在顶栏切换；也可以用**导出 / 导入配置**做备份迁移。

### 连接失败排查

浏览器直连 R2 失败时，「测试连接」会按错误类型给出针对性提示。对照下表定位：

| 页面提示 / 错误 | 原因 | 处理 |
| --- | --- | --- |
| 浏览器无法访问 R2（无 HTTP 响应） | 最常见：**桶未开 CORS**；其次：Endpoint 不可达 | 见下方「确认是不是 CORS」 |
| 403 SignatureDoesNotMatch | Access Key 与 Secret 不匹配 / 复制不完整 | 重新创建并复制令牌 |
| 403 AccessDenied | 令牌无权访问该桶 | 检查令牌权限范围、桶名大小写 |
| 404 NoSuchBucket | 桶名不存在 / 不可见 | 核对桶名拼写与令牌权限 |
| 400 InvalidAccessKeyId | 令牌已删除或撤销 | 重新创建 |

**确认是不是 CORS 的最快方法**：用本地诊断脚本在 Node 里直连 R2（Node 没有 CORS 限制）：

```bash
node tools/diagnose.js
# 按提示输入 Access Key / Secret / Endpoint / Bucket
# 或读取网页导出的配置备份：
node tools/diagnose.js --config r2-config.json
```

- 脚本**成功** → 配置完全正确，浏览器失败就只剩 CORS 一个原因，回到上方「配置 CORS」；
- 脚本**失败** → 它会输出具体 HTTP 状态码与 S3 错误码（SignatureDoesNotMatch / AccessDenied / NoSuchBucket 等），按上表处理即可。

> 补充：浏览器 CORS 失败时，开发者工具（F12）→ Network 里能看到 R2 请求被 `CORS error` 拦截，
> 或预检 `OPTIONS` 请求返回非 2xx，这是 CORS 未配置的铁证。

## 功能

| 功能 | 说明 |
| --- | --- |
| 文件上传 | 单个 / 多个 / 批量选择文件夹（保留目录结构）/ 拖拽上传，带进度条 |
| 目录浏览 | 面包屑导航、按层级浏览、文件夹与文件自动区分 |
| 文件下载 | 单个下载、多选批量下载，文件名从上传时写入的元数据还原 |
| 公开链接 | 基于「公共开发 URL / 自定义域」生成，支持多选批量复制 |
| 删除 | 单个 / 多选批量删除，服务端逐个 DELETE（4 路并发流水线），区分成功与失败项 |
| 重命名 / 移动 | 文件用 CopyObject 服务端复制后删除原件（不经过浏览器中转）；勾选后可**批量移动**到任意文件夹（目标文件夹选择器逐层选择），支持整棵文件夹移动 |
| 新建文件夹 | 写入 0 字节的目录占位对象 |
| 搜索 | 当前目录内即时过滤 |
| 分区视图 | 相册 / 视频 / 文档 / 音频分区，网格（缩略图）/ 列表视图按分区记忆；文件夹按子树内容过滤（按当前目录惰性建索引，上传增量维护）；长列表滚动分批渲染 |
| 容量统计 | 顶栏容量条（手机为独立容量行）持久缓存 + 增量维护（上传/删除实时加减，打开页面零全量扫描），点击可全量校准；超出上限拒绝上传 |
| 多配置管理 | 多条 R2 配置并存、顶栏切换、导入导出 JSON 备份；右上角「＋ 新建配置」随时添加新账号（每条配置独立的容量上限与用量统计） |
| 移动端适配 | 手机访问自动启用独立布局（底部操作栏、动作面板、紧凑列表），与桌面布局完全分离 |
| 打开/浏览速度 | JS 合并 + SW 静态缓存 + 目录 IndexedDB 持久缓存（秒开 + 后台刷新）+ 子目录预取 + 缩略图 srcset；调试加 ?debug=1 看耗时 |

## 使用说明

### 手机与电脑两套布局

站点会根据访问设备（UA + 触摸屏 + 屏幕尺寸）自动选择布局，两套布局互不混用：

- **手机**：顶栏下方是完整的容量条；分区 Tab 等宽铺满一行（无需左右滑动）；
  文件列表为单列紧凑行（缩略图 + 名称 + 大小·时间）；上传 / 新建放在底部固定操作栏，
  「选择」进入多选模式后底部栏切换为批量操作；点 `⋯` 或**长按**文件弹出动作面板（预览/下载/链接/重命名/删除）。
- **电脑**：传统表格 / 网格视图，容量组件显示在顶栏中部。

调试时可强制指定布局：`https://站点地址/?layout=mobile` 或 `?layout=desktop`。

### 关于「文件夹」

S3 / R2 没有真正的目录概念，文件夹只是 **key 以 `/` 结尾的 0 字节占位对象**。
因此：

- 新建文件夹会实际写入一个对象；
- 只列出占位对象、不含子文件的文件夹在 R2 控制台可能看不到，但本站会正常显示；
- 删除文件夹内的全部对象后，占位对象仍在，需要手动删除；
- 重命名文件夹会递归复制整棵子树到新前缀，再删除旧前缀下的全部对象。

### 关于文件大小与数量

请求全部在浏览器里完成，本站点不中转数据，因此：

- **上传**受浏览器与网络条件限制；单个大文件建议控制在数百 MB 以内；
- **列举**单次最多 1000 条，超出会自动翻页；
- **删除**采用逐个 DELETE 并发流水线（不是 S3 的批量 DeleteObjects），
  因为批量删除要求为请求体计算 AWS 专有的 Content-MD5（非标准哈希，浏览器无原生实现）。

## 架构

```
public/
  index.html        页面结构
  css/style.css     样式（浅色主题，响应式 + 手机独立布局）
  js/sigv4.js       AWS Signature V4 签名（零依赖）
  js/s3.js          S3 兼容 REST 客户端（基于 fetch）
  js/config.js      配置读写与校验（localStorage）
  js/app.js         界面逻辑
.github/workflows/
  ci.yml            GitHub Actions（只跑测试守门；部署由 Cloudflare Pages Git 集成完成）
tests/
  sigv4.test.js             签名单元测试（含 AES 风格的原语校验）
  s3-integration.test.js    mock S3 server 端到端集成测试
  browser-smoke.test.js     jsdom 真实浏览器环境验证
```

脚本按 `<script>` 顺序加载，无构建步骤、运行时零依赖：

1. `sigv4.js` —— 手写 SigV4，覆盖中文、空格、括号、`%`、空 body、PUT/HEAD/DELETE、query 参数等 12 个场景。
   正确性由 `sigv4.test.js` 的确定性断言保证（URI 编码语义、SHA-256/HMAC 原语、签名结构与幂等性）。
2. `s3.js` —— 基于 `fetch` 的 S3 客户端，实现 ListObjectsV2（自动翻页）、PUT、GET、HEAD、DELETE、CopyObject。
   关键点是**把签名时计算的 `x-amz-date` / `x-amz-content-sha256` 一并随请求发送**，否则服务端会报 `MissingHeaders`。
3. `config.js` —— 配置的增删改查、格式校验、导入导出、脱敏展示。
4. `app.js` —— 目录树渲染、上传队列、多选操作、拖拽、公开链接生成。

### 几个容易踩坑的点（本项目已处理）

- **`var` 提升遮蔽全局变量**：`var SigV4 = (typeof SigV4 !== 'undefined') ? SigV4 : require(...)`
  这种写法中，局部 `var SigV4` 会把右侧的 `SigV4` 解析为未初始化的局部变量，
  在浏览器里恒为 `undefined`，从而强制走 `require` 并抛 `ReferenceError`。
  正确做法是通过 `globalThis.SigV4` 读取。Node 下的 `require` 测试覆盖不到这条路径，
  所以必须有 jsdom 真实浏览器环境测试。
- **中文文件名写入 header 会失败**：HTTP header 值必须是 Latin-1（ByteString），
  直接写中文会让 `fetch` 抛 `Cannot convert argument to a ByteString...`。
  因此 `x-amz-meta-filename` 等用户元数据统一做百分号编码，读取时解码还原。
- **ListBucketResult 有两种条目形态**：`<Contents>`（真实对象）和
  `<CommonPrefixes>`（带 `delimiter` 时折叠出的子前缀）。
  不含子对象的空文件夹**只**以 CommonPrefixes 出现，漏解析会导致文件夹丢失。
- **列举结果不含目录占位对象**：`prefix=folder/` 时，
  `folder/` 占位对象自身也是 `<Contents>` 中的一项，需要一并渲染。
- **S3 始终返回完整 key**，不是相对 `prefix` 的路径。
- **R2 的 HEAD 响应不返回 `Content-Type`**，所以上传时额外写一份 `x-amz-meta-content-type` 用于读回展示。
- **HEAD 响应按 HTTP 规范不带 body**，无法从中解析错误码，只能依据状态码判定。

## 测试

```bash
npm test
```

共 49 项，覆盖：

- 签名原语（SHA-256 / HMAC 与 Node 权威 `crypto` 对比、`uriEncode` 规范、SignedHeaders 排序、签名幂等性）
- S3 客户端端到端（本地 mock S3 server，覆盖中文/空格/括号/`%` 的 key、文件夹与 CommonPrefixes 折叠、分页翻页、HEAD/GET/PUT/DELETE/CopyObject、错误分类、XML 解析）
- jsdom 真实浏览器环境（UMD 全局挂载、`var` 提升回归保护、配置读写校验导入导出、浏览器分支端到端）

## 安全性说明

请在使用前明确理解以下几点：

1. **密钥会出现在浏览器里**。为了让站点保持纯静态、零服务端，SigV4 签名必须在客户端完成，
   因此 Access Key ID / Secret Access Key 会以明文形式存在于访问者的 `localStorage`。
   **不要**把生产环境主令牌用于公共电脑或个人电脑上的共享实例。
2. **配置只在本机可见**，但一旦导出 JSON 备份就等同于明文密钥文件，请妥善保管。
   换机器可用导入功能迁移；离开后可用**清除本机配置**彻底移除。
3. **R2 令牌权限建议最小化**。在创建 API Token 时，权限范围限定到具体桶，
   并只授予需要的操作。令牌可在 Cloudflare 控制台随时撤销。
4. **公开链接即公开可读**。开启 Public bucket access 后，
   只要知道完整 key 就能直接访问文件，等同于公网匿名可读。
   敏感内容请勿使用公共访问功能；文件名请避免可猜测的连续编号。
5. **本站点不做用户鉴权**。配置页对所有访问者开放，
   任何拿到部署域名的人都能用（他自己的）R2 配置登录。若需要保护入口，
   请在 Cloudflare 侧用 Access / WAF / 自定义回源鉴权。

## 已知限制

- R2 的 `HEAD` 不返回 `Content-Type`，文件类型展示依赖上传时写入的 `x-amz-meta-content-type`；
  由外部工具上传的历史文件可能没有该元数据。
- 未配置「公共开发 URL」或「自定义域」时无法生成公开链接（只能下载）。
- 列举使用 `delimiter=/` 的层级折叠语义，深层文件不会与父目录同时列出。
- 大文件分片上传（≥64MB 自动启用，分片大小随文件 8/16/32MB 自适应、6 路并发）依赖桶 CORS 暴露 ETag；
  未配置 ExposeHeaders 时自动降级为整包上传（功能可用，弱网断点收益消失）。

## License

MIT
