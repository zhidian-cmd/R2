#!/usr/bin/env node
/**
 * R2 连接诊断脚本（本地运行，绕开浏览器 CORS 限制）
 *
 * 用途：在浏览器里「测试连接」失败时，用本脚本在 Node 环境直连 R2，
 * 明确区分问题类别：
 *   - 本脚本成功  → 配置本身正确，失败原因在浏览器侧（几乎必是 CORS）
 *   - 本脚本失败  → 配置问题，脚本会给出具体错误码与建议
 *
 * 用法：
 *   node tools/diagnose.js
 *     交互式输入 Access Key / Secret / Endpoint / Bucket
 *   或
 *   node tools/diagnose.js --config r2-config.json
 *     直接读取网页导出的配置备份（exportJson 格式）
 *   或
 *   node tools/diagnose.js --ak=xxx --sk=yyy --endpoint=zzz --bucket=bbb
 */
'use strict';
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const S3Client = require('../public/js/s3.js');

function ask(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); resolve(a.trim()); });
  });
}

function parseArgs() {
  const a = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) a[m[1]] = m[2];
    else if (arg === '--config') a.config = process.argv[process.argv.indexOf(arg) + 1];
  }
  return a;
}

function describeErr(e) {
  const lines = [];
  if (!e.status) {
    lines.push('无法收到 HTTP 响应（可能网络不通 / Endpoint 域名填错 / 代理拦截）。');
    lines.push('原始错误：' + e.message);
    return lines;
  }
  lines.push('HTTP ' + e.status + (e.code ? ' · ' + e.code : '') + (e.message ? ' · ' + e.message : ''));
  if (e.status === 403 && e.code === 'SignatureDoesNotMatch') {
    lines.push('→ Access Key 与 Secret 不匹配，或复制不完整。');
  } else if (e.status === 403 && e.code === 'AccessDenied') {
    lines.push('→ 令牌有效但无权访问该桶：检查令牌权限范围 / 桶名大小写 / Endpoint 账户。');
  } else if (e.status === 404) {
    lines.push('→ 桶不存在或不可见：检查桶名拼写（区分大小写）与令牌权限。');
  } else if (e.status === 400 && e.code === 'InvalidAccessKeyId') {
    lines.push('→ Access Key ID 无效或令牌已被撤销。');
  } else {
    lines.push('→ 请对照 Cloudflare 控制台核对各项配置。');
  }
  return lines;
}

async function main() {
  const args = parseArgs();
  let cfg = {};

  if (args.config) {
    const raw = fs.readFileSync(args.config, 'utf8');
    const data = JSON.parse(raw);
    const list = Array.isArray(data) ? data : (data.configs || []);
    if (!list.length) throw new Error('配置文件中没有可用配置');
    cfg = list[0];
    console.log('已从配置文件读取配置：' + (cfg.name || cfg.bucket));
  } else if (args.ak) {
    cfg = { accessKeyId: args.ak, secretAccessKey: args.sk, endpoint: args.endpoint, bucket: args.bucket };
  } else {
    console.log('== R2 连接诊断 ==');
    cfg.accessKeyId = await ask('Access Key ID: ');
    cfg.secretAccessKey = await ask('Secret Access Key: ');
    cfg.endpoint = await ask('Endpoint (https://xxx.r2.cloudflarestorage.com): ');
    cfg.bucket = await ask('Bucket: ');
  }

  if (!cfg.accessKeyId || !cfg.secretAccessKey || !cfg.endpoint || !cfg.bucket) {
    console.error('\n错误：四项必填信息不完整。');
    process.exit(1);
  }

  console.log('\n正在连接 ' + cfg.endpoint.replace(/^https?:\/\//, '') + ' / ' + cfg.bucket + ' ...');
  const client = new S3Client({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    endpoint: cfg.endpoint,
    bucket: cfg.bucket,
    region: 'auto'
  });

  try {
    const page = await client.list({ prefix: '', maxKeys: 10 });
    console.log('\n✅ 连接成功！桶「' + cfg.bucket + '」可正常访问，当前可见条目：' + page.items.length);
    console.log('   （若浏览器里仍然失败，问题几乎可以确定是 CORS 未配置，见 README）');
    process.exit(0);
  } catch (e) {
    console.log('\n❌ 连接失败。');
    describeErr(e).forEach(l => console.log('   ' + l));
    if (!e.status) {
      console.log('\n提示：这个错误发生在 Node 环境（无 CORS 限制），说明不是浏览器 CORS 问题，');
      console.log('      而是 Endpoint 不可达或网络问题。请核对 Endpoint 域名。');
    } else {
      console.log('\n提示：Node 环境无 CORS 限制。若此处失败，说明配置本身有问题；');
      console.log('      修复后浏览器里通常就能连接（浏览器还需额外配置 R2 桶的 CORS）。');
    }
    process.exit(1);
  }
}

main().catch((e) => { console.error('诊断脚本错误：', e.message); process.exit(1); });
