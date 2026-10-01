'use strict';
// 死代码扫描（开发辅助，一次性工具）：找出 CSS 中定义但 HTML/JS/测试都未引用的类名
// 用法：node tools/scan-dead-css.js —— 输出仅为「候选」，删除前必须人工确认
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const css = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const jsFiles = ['app.js', 'config.js', 's3.js', 'sigv4.js'];
const js = jsFiles.map(f => fs.readFileSync(path.join(ROOT, 'public/js', f), 'utf8')).join('\n');
const testsDir = path.join(ROOT, 'tests');
const tests = fs.readdirSync(testsDir).map(f => fs.readFileSync(path.join(testsDir, f), 'utf8')).join('\n');
const headers = fs.readFileSync(path.join(ROOT, 'public/_headers'), 'utf8');
const haystack = html + '\n' + js + '\n' + tests + '\n' + headers;

const classes = new Set();
for (const m of css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)) classes.add(m[1]);

const used = new Set();
for (const m of haystack.matchAll(/class="([^"]+)"/g)) m[1].split(/\s+/).forEach(c => used.add(c));
for (const m of haystack.matchAll(/className\s*=\s*'([^']+)'/g)) m[1].split(/\s+/).forEach(c => used.add(c));
for (const m of haystack.matchAll(/classList\.(?:add|toggle|remove)\('([^']+)'/g)) used.add(m[1]);
// JS 里以任意形式出现的类名词（含字符串拼接、querySelector 等）
for (const c of classes) {
  const re = new RegExp("['\"`. ]" + c + "(?![a-zA-Z0-9_-])");
  if (re.test(js) || re.test(tests)) used.add(c);
}

const dead = [...classes].sort().filter(c => !used.has(c));
console.log('疑似未使用的 CSS 类（共 ' + dead.length + ' 个，删除前需人工确认）:');
console.log(dead.length ? dead.join('\n') : '(无)');
