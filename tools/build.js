'use strict';
/**
 * build.js - 把 public/js 下 4 个源文件按依赖顺序合并为 bundle.js（零依赖，纯 Node）
 *
 * 为什么合并：首屏从 4 个脚本请求降到 1 个（配合 defer/preload，解析期并行下载仍保留）。
 * 产物提交进仓库——Cloudflare Pages Git 集成按目录直接部署，无构建步骤。
 *
 * ⚠ 修改 public/js 源文件后必须重新运行 `node tools/build.js`，
 *   否则线上 bundle 过期（CI 里有新鲜度校验，不一致会红灯提醒）。
 *
 * 用法：node tools/build.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'public', 'js');
const SRC = ['sigv4.js', 's3.js', 'config.js', 'app.js']; // 依赖顺序
const OUT = path.join(SRC_DIR, 'bundle.js');

const banner = '/* 由 tools/build.js 生成（sigv4 + s3 + config + app 按依赖顺序合并）。' +
  '不要手改本文件：修改 public/js 源文件后运行 node tools/build.js 重新生成。 */\n';

let out = banner;
for (const f of SRC) {
  out += '\n// ==== ' + f + ' ====\n' + fs.readFileSync(path.join(SRC_DIR, f), 'utf8').replace(/\r\n/g, '\n') + '\n';
}
fs.writeFileSync(OUT, out);
console.log('bundle.js written:', (out.length / 1024).toFixed(1) + ' KB');
