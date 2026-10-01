/**
 * config.js - 连接配置的读写与校验（零依赖，浏览器运行）
 *
 * 核心诉求：网站只需部署一次，R2 的连接信息全部在页面里填写并保存在本地浏览器
 * （localStorage），因此任何人都可以 fork / 部署得到同一个静态站点，互不干扰。
 *
 * 字段（与 Cloudflare 控制台「R2 → 创建 API 令牌」页面的字段一一对应）：
 *   accessKeyId   访问密钥 ID            —— 必填
 *   secretAccessKey 机密访问密钥          —— 必填
 *   endpoint      S3 兼容终结点           —— 必填，形如 https://xxx.r2.cloudflarestorage.com
 *   bucket        存储桶名称              —— 必填
 *   publicUrl     R2 公共开发 URL（可选）  —— 形如 https://pub-xxx.r2.dev
 *   customDomain  自定义域（可选）        —— 形如 https://your-domain.com
 *
 * 注意：secretAccessKey 会明文保存在本地浏览器 localStorage 中，属于本机凭据，
 * 请勿在公共电脑上输入生产令牌；离开后可用「清除本机配置」彻底移除。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.R2Config = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STORE_KEY = 'r2em.configs.v1';
  var ACTIVE_KEY = 'r2em.activeId.v1';

  /** 字段定义：供表单渲染与校验共用 */
  var FIELDS = [
    { key: 'accessKeyId', label: '访问密钥 ID', required: true, placeholder: 'AKIA...（令牌 ID）', secret: false },
    { key: 'secretAccessKey', label: '机密访问密钥', required: true, placeholder: '机密访问密钥（仅本机可见）', secret: true },
    { key: 'endpoint', label: 'S3 兼容终结点', required: true, placeholder: 'https://xxx.r2.cloudflarestorage.com' },
    { key: 'bucket', label: '存储桶名称', required: true, placeholder: 'my-bucket' },
    { key: 'publicUrl', label: 'R2 公共开发 URL（可选）', required: false, placeholder: 'https://pub-xxx.r2.dev' },
    { key: 'customDomain', label: '自定义域（可选）', required: false, placeholder: 'https://your-domain.com' },
    { key: 'capacityGB', label: '容量上限（GB，可选）', required: false, placeholder: '默认 10' }
  ];

  var EMPTY = {
    name: '',
    accessKeyId: '',
    secretAccessKey: '',
    endpoint: '',
    bucket: '',
    publicUrl: '',
    customDomain: '',
    capacityGB: ''
  };

  function uid() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /** 读取全部配置；格式异常时静默回退为空数组，保证站点可用性 */
  function loadAll() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return [];
      var data = JSON.parse(raw);
      if (!Array.isArray(data)) return [];
      return data.filter(function (c) { return c && typeof c === 'object'; });
    } catch (e) {
      return [];
    }
  }

  function saveAll(list) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(list));
    } catch (e) {
      // 隐私模式 / 配额满时保存失败，不应阻断使用
      console.warn('配置保存失败：', e);
    }
  }

  function getActiveId() {
    try { return localStorage.getItem(ACTIVE_KEY) || ''; } catch (e) { return ''; }
  }

  function setActiveId(id) {
    try {
      if (id) localStorage.setItem(ACTIVE_KEY, id);
      else localStorage.removeItem(ACTIVE_KEY);
    } catch (e) { /* ignore */ }
  }

  /** 当前生效的配置；不存在时返回 null（此时应展示配置页） */
  function getActive() {
    var list = loadAll();
    var id = getActiveId();
    var found = list.filter(function (c) { return c.id === id; })[0];
    return found || null;
  }

  /** 新增或更新一条配置，并设为当前生效项 */
  function upsert(cfg) {
    var list = loadAll();
    var clean = clone(cfg);
    for (var i = 0; i < FIELDS.length; i++) {
      var k = FIELDS[i].key;
      if (clean[k] === undefined) clean[k] = '';
      clean[k] = String(clean[k]).trim();
    }
    if (!clean.id) clean.id = uid();
    if (!clean.name) {
      clean.name = clean.bucket ? ('R2 · ' + clean.bucket) : ('配置 ' + (list.length + 1));
    }

    var idx = -1;
    for (var j = 0; j < list.length; j++) {
      if (list[j].id === clean.id) { idx = j; break; }
    }
    if (idx === -1) list.push(clean);
    else list[idx] = clean;

    saveAll(list);
    setActiveId(clean.id);
    return clone(clean);
  }

  /** 按 id 删除配置；若删的是当前生效项，则切到第一条 */
  function remove(id) {
    var list = loadAll().filter(function (c) { return c.id !== id; });
    saveAll(list);
    if (getActiveId() === id) {
      setActiveId(list.length ? list[0].id : '');
    }
    return list;
  }

  /** 清空本机全部配置 */
  function clearAll() {
    saveAll([]);
    setActiveId('');
  }

  function setActive(id) {
    setActiveId(id);
  }

  /**
   * 校验配置完整性与格式。
   * 返回 { ok: boolean, errors: { field: message } }
   */
  function validate(cfg) {
    var errors = {};
    FIELDS.forEach(function (f) {
      var v = (cfg && cfg[f.key] !== undefined) ? String(cfg[f.key]).trim() : '';
      if (f.required && !v) {
        errors[f.key] = '必填';
        return;
      }
      if (!v) return;
      if (f.key === 'endpoint') {
        if (!/^https?:\/\//i.test(v)) errors[f.key] = '需以 https:// 开头';
      } else if (f.key === 'publicUrl' || f.key === 'customDomain') {
        if (!/^https?:\/\//i.test(v)) errors[f.key] = '需以 https:// 开头';
      } else if (f.key === 'bucket') {
        // S3 桶名规范：3-63 字符、字符集受限、不能以点/连字符开头结尾、不能是 IP 形式
        if (/[^A-Za-z0-9._-]/.test(v)) errors[f.key] = '仅允许字母、数字、._-';
        else if (v.length < 3 || v.length > 63) errors[f.key] = '长度需在 3-63 之间';
        else if (/^[.-]|[.-]$/.test(v)) errors[f.key] = '不能以点或连字符开头/结尾';
        else if (/^\d+\.\d+\.\d+\.\d+$/.test(v)) errors[f.key] = '不能是 IP 地址形式';
      } else if (f.key === 'secretAccessKey' && v.length < 12) {
        errors[f.key] = '长度异常，请检查是否复制完整';
      }
    });
    return { ok: Object.keys(errors).length === 0, errors: errors };
  }

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  /** 构造一条新配置对象 */
  function blank() {
    return clone(EMPTY);
  }

  /** 按「accessKeyId + endpoint + bucket」生成稳定指纹 id：
   *  备份文件缺失 id 时重复导入不会堆积重复配置（同三元组 → 同 id → upsert 覆盖） */
  function fingerprintId(triple) {
    var s = String(triple || '');
    var h = 0x811c9dc5; // FNV-1a 32 位
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return 'fp' + h.toString(36);
  }

  /**
   * 拼接文件的公开访问地址。
   * 优先级：自定义域 > R2 公共开发 URL。
   * 未配置公开地址时返回 null（表示只能走本站下载，不适合直接分享）。
   */
  function publicUrlOf(cfg, key) {
    var base = cfg.customDomain || cfg.publicUrl;
    if (!base) return null;
    var normalized = base.replace(/\/+$/, '');
    var encoded = String(key).split('/').map(encodeURIComponent).join('/');
    return normalized + '/' + encoded;
  }

  /** 导出配置为 JSON 文本（含全部字段，便于备份或迁移到另一台机器） */
  function exportJson() {
    return JSON.stringify({ _type: 'R2EnhancedManager', version: 1, configs: loadAll() }, null, 2);
  }

  /** 导入 JSON 文本；成功返回导入的配置条数，失败抛出 Error */
  function importJson(text) {
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('JSON 解析失败：' + e.message);
    }
    var incoming = Array.isArray(data) ? data : (data && data.configs);
    if (!Array.isArray(incoming)) throw new Error('文件格式不正确：缺少配置数组');

    var list = loadAll();
    var count = 0;
    incoming.forEach(function (c) {
      if (!c || typeof c !== 'object') return;
      var merged = blank();
      ['id', 'name', 'accessKeyId', 'secretAccessKey', 'endpoint', 'bucket', 'publicUrl', 'customDomain', 'capacityGB']
        .forEach(function (k) { if (c[k] !== undefined) merged[k] = String(c[k]); });
      if (!merged.accessKeyId || !merged.secretAccessKey || !merged.endpoint || !merged.bucket) return;
      var check = validate(merged);
      if (!check.ok) return;
      // id 缺失或与三元组指纹不符时改用指纹 id：同一份凭证重复导入按内容去重，
      // 不会因生成随机 id 而堆积重复配置；已有同三元组配置则复用其 id（就地更新）
      var fp = fingerprintId(merged.accessKeyId + '|' + merged.endpoint + '|' + merged.bucket);
      var existing = list.filter(function (x) {
        return x.accessKeyId === merged.accessKeyId && x.endpoint === merged.endpoint && x.bucket === merged.bucket;
      })[0];
      if (existing) merged.id = existing.id;
      else if (!merged.id) merged.id = fp;
      var idx = -1;
      for (var i = 0; i < list.length; i++) if (list[i].id === merged.id) { idx = i; break; }
      if (idx === -1) list.push(merged);
      else list[idx] = merged;
      count++;
    });
    if (!count) throw new Error('没有可导入的有效配置（字段不全或校验失败）');
    saveAll(list);
    if (!getActiveId()) setActiveId(list[0].id);
    return count;
  }

  return {
    FIELDS: FIELDS,
    blank: blank,
    loadAll: loadAll,
    getActive: getActive,
    upsert: upsert,
    remove: remove,
    clearAll: clearAll,
    setActive: setActive,
    validate: validate,
    publicUrlOf: publicUrlOf,
    exportJson: exportJson,
    importJson: importJson
  };
});
