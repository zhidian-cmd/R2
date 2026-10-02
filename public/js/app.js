/**
 * app.js - 文件管理界面逻辑
 *
 * 依赖顺序（见 index.html）：sigv4.js → s3.js → config.js → app.js
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  // 高频元素引用缓存（app.js 在 DOM 就绪后执行；零查询开销）
  var EL = {};
  ['connStatus', 'capWidget', 'capFill', 'capText', 'mCapStrip', 'mCapDot', 'mCapText',
   'mCapFill', 'progress', 'progressBar', 'progressTitle', 'progressSub', 'toast',
   'fileBody', 'gridBody', 'breadcrumb', 'moveCrumb', 'moveFolders', 'emptyState'
  ].forEach(function (id) { EL[id] = document.getElementById(id); });

  var cfg = R2Config;
  var activeConfig = null;
  var s3 = null;
  var currentDir = '';        // 当前目录前缀，始终以 '/' 结尾或为空
  var items = [];             // 当前目录的条目
  var selected = new Set();   // 已勾选的条目名
  var searchText = '';

  // ---------- 设备检测（手机 / 电脑两套完全独立的布局） ----------
  // 手机走 body.mobile 独立布局（底部操作栏 + 动作面板 + 紧凑列表），
  // 电脑保持原布局，二者不混用。
  // 判定：UA + 触摸屏 + 屏幕短边。用 screen 尺寸而非 innerWidth，
  // 手机弹出键盘（触发 resize）或旋转都不会误切布局。
  // 另支持 ?layout=mobile / ?layout=desktop 强制指定（调试用）。
  function computeIsMobile() {
    var ua = navigator.userAgent || '';
    if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua)) return true;
    var coarse = false;
    var shortSide = 0;
    try {
      coarse = window.matchMedia('(pointer: coarse)').matches;
      shortSide = Math.min(screen.width || 0, screen.height || 0);
    } catch (e) { /* ignore */ }
    return coarse && shortSide > 0 && shortSide <= 820;
  }
  var layoutForced = null;
  try {
    var q = new URLSearchParams(location.search);
    if (q.get('layout') === 'mobile') layoutForced = true;
    else if (q.get('layout') === 'desktop') layoutForced = false;
  } catch (e) { /* ignore */ }
  var IS_MOBILE = layoutForced !== null ? layoutForced : computeIsMobile();
  var selectMode = false;   // 手机：多选模式（底部栏切换为批量操作）
  var lpFired = false;      // 长按已触发时吞掉其后的合成 click
  var FOLDER_UPLOAD_SUPPORTED = 'webkitdirectory' in document.createElement('input');

  // ---------- 浮层与手机返回键 ----------
  // 手机用户习惯按系统返回键关闭弹层，而不是退出网站。
  // 打开浮层（预览/动作面板/移动选择器/设置页）时压入一条历史记录，
  // 返回键触发 popstate 时关闭浮层；点 ✕ 主动关闭时回退历史保持栈同步。
  var overlayActive = null; // 'preview' | 'move' | 'sheet' | 'config' | null

  function overlayOpen(name) {
    if (overlayActive) return; // 浮层不叠加
    overlayActive = name;
    try { history.pushState({ overlay: name }, ''); } catch (e) { overlayActive = null; }
  }

  function overlayClose(name, viaPop) {
    if (overlayActive !== name) return;
    overlayActive = null;
    if (!viaPop) {
      // UI 主动关闭：回退历史让栈与界面同步（popstate 到来时 overlayActive 已空，不会二次关闭）
      try { if (history.state && history.state.overlay) history.back(); } catch (e) { /* ignore */ }
    }
  }

  window.addEventListener('popstate', function () {
    if (overlayActive) {
      var name = overlayActive;
      overlayActive = null;
      if (name === 'preview') closePreview(true);
      else if (name === 'move') closeMovePicker(true);
      else if (name === 'sheet') closeSheet(true);
      else if (name === 'config') closeConfigView(true);
      return;
    }
    // 无浮层时的返回键：先退出多选模式（若在），再按才真正离开
    if (selectMode) setSelectMode(false);
  });

  // ---------- 工具 ----------
  var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  var ESC_RE = /[&<>"']/;
  function escapeHtml(s) {
    if (s == null) return '';
    s = String(s);
    if (!ESC_RE.test(s)) return s; // 快路径：绝大多数文件名不含特殊字符，零分配
    return s.replace(/[&<>"']/g, function (c) { return ESC_MAP[c]; });
  }

  /** 容错解码：key 里可能含有裸 '%'（如「100%」文件夹），decodeURIComponent 会抛 URIError */
  function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  var fmtTimer;
  function toast(msg, type) {
    var el = EL.toast;
    el.textContent = msg;
    el.className = 'toast ' + (type || '');
    el.hidden = false;
    clearTimeout(fmtTimer);
    fmtTimer = setTimeout(function () { el.hidden = true; }, type === 'err' ? 4200 : 2400);
  }

  /**
   * 进度展示（两行式）：pct 为 0-100 数字（条宽与副行的百分数一致），
   * null 表示不定进度（细条脉冲）。title 一行（文件名/状态），sub 一行（百分数+计数）。
   * 注意：上传时条宽是「整体进度」（完成文件数 + 当前文件字节进度），
   * 不再出现"左边一个不动的大百分数"。
   */
  var _progressRaf = null;
  var _progressPending = null;
  function showProgress(pct, title, sub) {
    if (EL.progress.hidden) pendingOps++;
    EL.progress.hidden = false;
    _progressPending = { pct: pct, title: title || '', sub: sub || '' };
    if (_progressRaf != null) return; // 一帧内多次进度事件合并为一次 DOM 写入
    _progressRaf = requestAnimationFrame(function () {
      _progressRaf = null;
      if (EL.progress.hidden || !_progressPending) return;
      var d = _progressPending;
      EL.progressTitle.textContent = d.title;
      EL.progressSub.textContent = d.sub;
      EL.progressBar.style.width = d.pct == null
        ? '12%'
        : Math.max(0, Math.min(100, Math.round(d.pct))) + '%';
    });
  }
  function hideProgress() {
    if (_progressRaf != null) { cancelAnimationFrame(_progressRaf); _progressRaf = null; }
    _progressPending = null;
    if (!EL.progress.hidden) pendingOps = Math.max(0, pendingOps - 1);
    // activeOpCount 至少包含当前这次操作（endOp 在调用方的 finally 里尚未执行），
    // 「还有其他操作在跑」是 > 1 而非 > 0——否则面板永远不隐藏，只清空内容挂成空卡片
    if (activeOpCount > 1) {
      EL.progressBar.style.width = '0';
      EL.progressTitle.textContent = '';
      EL.progressSub.textContent = '';
      return;
    }
    EL.progress.hidden = true;
    EL.progressBar.style.width = '0';
  }


  function humanSize(bytes) {
    var n = Number(bytes) || 0;
    if (n === 0) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = Math.floor(Math.log(n) / Math.log(1024));
    i = Math.min(i, units.length - 1);
    var v = n / Math.pow(1024, i);
    return (i === 0 ? v : v.toFixed(2)) + ' ' + units[i];
  }

  function fmtDate(s) {
    if (!s) return '—';
    var d = new Date(s);
    if (isNaN(d.getTime())) return s;
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /** 带缓存的日期格式化：同一 item 反复渲染（分批追加/重绘）时避免重复创建 Date */
  function fmtDateCached(item) {
    if (!item.lastModified) return '—';
    if (item._dateStr === undefined) item._dateStr = fmtDate(item.lastModified);
    return item._dateStr;
  }

  function iconFor(item) {
    if (item.isFolder) return { cls: 'folder', text: '📁' };
    var name = item.name.toLowerCase();
    if (/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/.test(name)) return { cls: '', text: '🖼' };
    if (/\.(mp4|mov|avi|mkv|webm)$/.test(name)) return { cls: '', text: '🎬' };
    if (/\.(mp3|wav|flac|m4a|ogg)$/.test(name)) return { cls: '', text: '🎵' };
    if (/\.(zip|tar|gz|7z|rar|bz2)$/.test(name)) return { cls: '', text: '🗜' };
    if (/\.(md|txt|log)$/.test(name)) return { cls: '', text: '📝' };
    if (/\.(json|xml|ya?ml|ini|conf|csv)$/.test(name)) return { cls: '', text: '⚙' };
    return { cls: '', text: '📄' };
  }

  function baseName(name) {
    var n = name.replace(/\/$/, '');
    var i = n.lastIndexOf('/');
    return i >= 0 ? n.slice(i + 1) : n;
  }

  /** 复制文本到剪贴板，兼容非 https 环境 */
  function copyText(text) {
    var done = function (ok) {
      toast(ok ? '已复制到剪贴板' : '复制失败，请手动复制', ok ? 'ok' : 'err');
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { done(true); },
        function () { done(legacyCopy(text)); });
      return;
    }
    done(legacyCopy(text));
  }
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename || baseName(currentDir);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ---------- 连接 ----------
  function buildClient(config) {
    return new S3Client({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      endpoint: config.endpoint,
      bucket: config.bucket,
      region: 'auto'
    });
  }

  var connState = '';
  var connText = '未连接';

  function updateConnStatus(state, text) {
    connState = state || '';
    connText = text || '未连接';
    paintStatus();
  }

  /**
   * 统一渲染三处状态展示（共用同一份数据，避免手机端被顶栏截断）：
   *   - connStatus：顶栏状态文字（桌面）
   *   - capWidget：顶栏中部容量组件（桌面，填补顶栏留白）
   *   - mCapStrip：容量条（手机独立布局，完整展示桶名与用量）
   */
  var _paintPending = false;
  function paintStatus() {
    if (_paintPending) return;
    _paintPending = true;
    requestAnimationFrame(function () {
      _paintPending = false;
      doPaintStatus();
    });
  }

  function doPaintStatus() {
    var el = EL.connStatus;
    el.className = 'conn-status ' + connState;
    el.textContent = connText;

    // 用量只采信本会话实时扫描的结果；未扫完前显示「统计中」，绝不显示 0
    var dataReady = usageReady();
    var scanning = !!(activeConfig && (usage.scanId === activeConfig.id || usage.scan));
    var used = dataReady ? usage.bytes / (1024 * 1024 * 1024) : null;
    var limit = capacityLimitGB();
    var over = used != null && used >= limit;
    var pct = used == null ? 0 : Math.min(100, used / limit * 100);
    var usedStr = used == null ? '' : (used >= 0.01 ? used.toFixed(2) : '0.00') + ' GB';

    var w = EL.capWidget;
    if (!activeConfig) {
      w.hidden = true;
    } else {
      w.hidden = false;
      EL.capFill.style.width = pct + '%';
      EL.capFill.classList.toggle('over', !!over);
      if (used == null) {
        // 统计中：已扫出部分对象数时实时显示进度，避免大桶长时间"干等"没有反馈
        var n = usage.progressCount;
        EL.capText.textContent = scanning
          ? (n ? '容量统计中… 已扫 ' + n.toLocaleString() + ' 个对象' : '容量统计中…')
          : '容量未统计 · 点击重试';
      } else {
        EL.capText.textContent = '已用 ' + usedStr + ' / ' + limit + ' GB';
      }
    }

    var strip = EL.mCapStrip;
    if (!activeConfig) {
      strip.hidden = true;
      return;
    }
    strip.hidden = false;
    var state = connState;
    var txt;
    if (connState === 'err') {
      txt = connText;
    } else {
      // 手机端：桶名 + 已用/上限（数字缺失时显示统计状态），不再只给桶名
      txt = activeConfig.bucket;
      if (used != null) {
        txt += ' · ' + usedStr + ' / ' + limit + ' GB';
        state = over ? 'err' : 'on';
      } else {
        var pn = usage.progressCount;
        txt += scanning
          ? (pn ? ' · 统计中 ' + pn.toLocaleString() : ' · 容量统计中…')
          : ' · 容量未统计';
      }
    }
    EL.mCapDot.className = 'm-cap-dot ' + state;
    EL.mCapText.textContent = txt;
    EL.mCapText.title = activeConfig
      ? activeConfig.bucket + ' · 已用 ' + (used == null ? '…' : usedStr) + ' / ' + limit + ' GB'
      : txt;
    EL.mCapFill.style.width = pct + '%';
    EL.mCapFill.classList.toggle('over', !!over);
  }

  /** 生成状态栏文本：桶名 + 截断的账户 ID，避免手机端过长溢出 */
  function connLabel(config) {
    if (!config) return '未连接';
    var endpoint = String(config.endpoint || '').replace(/^https?:\/\//, '');
    var acct = endpoint.split('.')[0]; // 账户 ID
    var short = acct.length > 8 ? acct.slice(0, 8) + '…' : acct;
    return config.bucket + ' · ' + short;
  }

  function applyConfig(config) {
    activeConfig = config;
    s3 = config ? buildClient(config) : null;
    overlayClose('config'); // 保存/切换配置会回到文件页：同步浮层与历史栈
    dirCacheClear(); // 缓存不区分桶：切换配置必须整体失效，否则会显示旧桶的目录内容
    dirBitsCache.clear(); // 文件夹内容索引同理
    if (config) {
      // 预热 R2 endpoint 的 TLS 握手（preconnect）：后续第一 个 API 请求省 1 个 RTT
      try {
        var epHost = new URL(config.endpoint).origin;
        var pc = document.querySelector('link[rel="preconnect"][data-r2]');
        if (!pc) {
          pc = document.createElement('link');
          pc.rel = 'preconnect';
          pc.setAttribute('data-r2', '1');
          pc.crossOrigin = '';
          document.head.appendChild(pc);
        }
        pc.href = epHost;
      } catch (e) { /* endpoint 非法时忽略 */ }
      // 持久化当前选择：否则切换配置后刷新页面会跳回旧配置
      cfg.setActive(config.id);
      var fullLabel = config.bucket + ' · ' + config.endpoint.replace(/^https?:\/\//, '');
      updateConnStatus('on', connLabel(config));
      $('connStatus').title = fullLabel;
      $('cfgSelect').value = config.id;
    } else {
      updateConnStatus('', '未连接');
    }
    $('cfgTitle').textContent = '连接配置';
    $('viewConfig').hidden = !!config;
    $('viewFiles').hidden = !config;
    $('btnSettings').textContent = config ? '⚙ 设置' : '⚙ 连接';
    if (config) {
      currentDir = '';
      loadDir();
      // 终止上一个桶还在跑的后台扫描：省带宽，避免新旧两份扫描抢连接拖慢浏览/预览
      if (usageAbort) { try { usageAbort.abort(); } catch (e) { /* ignore */ } usageAbort = null; }
      // 容量：从按桶缓存恢复本会话已扫出的数字（切走再切回不再"消失"）。
      // 会话内有可信数字（本次扫描结果 + 此后一直增量维护）就不再重复全量扫描——
      // 这是"进站/切桶变快"的关键；校准靠手动点容量条（扫完写回 R2 记录）。
      var cached = usageCache[config.id];
      if (cached) {
        usage.id = config.id;
        usage.objectBytes = cached.objectBytes;
        usage.partBytes = cached.partBytes;
        usage.bytes = cached.bytes;
        usage.objectCount = cached.objectCount;
        usage.uploads = cached.uploads;
        usage.scannedAt = cached.scannedAt;
        usage.progressCount = null;
        renderUsageText();
      } else {
        resetUsage();
        renderUsageText();
        // 本会话无数字：读 R2 上的持久容量记录。命中则立即秒显（免全量扫描），
        // 未命中（新桶/记录丢失或损坏）才回退到全量扫描——扫完会写回建立记录
        readUsageRecord().then(function (rec) {
          if (!activeConfig || activeConfig.id !== config.id) return; // 已切走
          if (!rec) {
            // 无记录：自动全量扫描建立基线并写回（自愈路径）
            if (!(usage.id === config.id && usage.scannedAt)) scanUsage();
            return;
          }
          if (usage.id === config.id && usage.scannedAt) return; // 期间已有可信数字（手动扫描接管）
          usage.id = config.id;
          usage.objectBytes = rec.totalBytes;
          usage.partBytes = 0; // 记录不区分分片占用，扫描校准后恢复精确值
          usage.bytes = rec.totalBytes;
          usage.objectCount = rec.objectCount;
          usage.uploads = 0;
          usage.scannedAt = rec.updatedAt || Date.now();
          usage.progressCount = null;
          usageCache[config.id] = {
            objectBytes: usage.objectBytes, partBytes: usage.partBytes, bytes: usage.bytes,
            objectCount: usage.objectCount, uploads: 0, scannedAt: usage.scannedAt
          };
          renderUsageText();
          alarmIfOverLimit();
        }).catch(function () { /* ignore */ });
      }
    }
  }

  function showConfigView() {
    formEditingNew = false;
    // 配置页作为独立界面打开：完全隐藏文件页，避免两个页面挤在一起
    overlayOpen('config');
    $('viewFiles').hidden = true;
    $('viewConfig').hidden = false;
    $('cfgTitle').textContent = '连接配置';
    $('btnCfgBack').hidden = !activeConfig; // 尚无任何已保存配置时无处可返
    $('btnDeleteCfg').hidden = !activeConfig;
    fillConfigForm(activeConfig || cfg.blank());
  }

  /**
   * 新建配置：打开空白表单，保存时生成一条新配置（不覆盖当前生效的配置）。
   * 没有这个入口时，一旦存在配置，设置页永远是「编辑当前配置」，
   * 用户无法在界面上添加第二个账号。
   */
  function showNewConfigView() {
    formEditingNew = true;
    overlayOpen('config');
    $('viewFiles').hidden = true;
    $('viewConfig').hidden = false;
    $('cfgTitle').textContent = '新建连接配置';
    $('btnCfgBack').hidden = !activeConfig;
    $('btnDeleteCfg').hidden = true; // 新建模式没有"当前配置"可删
    fillConfigForm(cfg.blank());
    var nameInput = $('cfgForm').elements['name'];
    if (nameInput) nameInput.focus();
  }

  /** 返回文件列表（不保存表单）；没有已生效配置时无处可返 */
  function closeConfigView(viaPop) {
    if (!activeConfig) return;
    overlayClose('config', viaPop);
    $('viewConfig').hidden = true;
    $('viewFiles').hidden = false;
    updateSelBar();
  }

  // ---------- 配置表单 ----------
  function fillConfigForm(c) {
    var form = $('cfgForm');
    var keys = ['name', 'accessKeyId', 'secretAccessKey', 'endpoint', 'bucket', 'publicUrl', 'customDomain', 'capacityGB'];
    keys.forEach(function (k) {
      var input = form.elements[k];
      if (input) input.value = (c && c[k]) || '';
    });
    keys.forEach(function (k) {
      var input = form.elements[k];
      if (input) input.classList.remove('invalid');
    });
    $('cfgErrors').hidden = true;
  }

  var formEditingNew = false; // 配置表单当前是否处于「新建」模式（保存时生成新 id 而非覆盖当前配置）

  function readForm() {
    var form = $('cfgForm');
    var obj = { id: formEditingNew ? '' : (activeConfig ? activeConfig.id : '') };
    ['name', 'accessKeyId', 'secretAccessKey', 'endpoint', 'bucket', 'publicUrl', 'customDomain', 'capacityGB']
      .forEach(function (k) {
        var el = form.elements[k];
        obj[k] = el ? el.value : '';
      });
    return obj;
  }

  function renderErrors(errors) {
    var box = $('cfgErrors');
    var html = '<ul>';
    Object.keys(errors).forEach(function (k) {
      html += '<li><strong>' + escapeHtml(k) + '</strong>：' + escapeHtml(errors[k]) + '</li>';
    });
    html += '</ul>';
    box.innerHTML = html;
    box.hidden = false;
  }

  function saveConfig(e) {
    if (e) e.preventDefault();
    var form = $('cfgForm');
    cfg.FIELDS.forEach(function (f) {
      var input = form.elements[f.key];
      if (input) input.classList.remove('invalid');
    });
    var data = readForm();
    var check = cfg.validate(data);
    if (!check.ok) {
      renderErrors(check.errors);
      Object.keys(check.errors).forEach(function (k) {
        var input = form.elements[k];
        if (input) input.classList.add('invalid');
      });
      return;
    }
    var saved = cfg.upsert(data);
    formEditingNew = false;
    applyConfig(saved);
    renderConfigSelect();
    toast('配置已保存并连接', 'ok');
  }

  /**
   * 把连接诊断结果显示在表单错误区（比 toast 更醒目、可持续阅读）
   */
  function renderConnError(title, lines) {
    var box = $('cfgErrors');
    var html = '<p><strong>' + escapeHtml(title) + '</strong></p><ul>';
    (lines || []).forEach(function (l) { html += '<li>' + escapeHtml(l) + '</li>'; });
    html += '</ul>';
    box.innerHTML = html;
    box.hidden = false;
  }

  async function testConnection() {
    var data = readForm();
    var check = cfg.validate(data);
    if (!check.ok) {
      renderErrors(check.errors);
      toast('请先填写必填项', 'err');
      return;
    }
    var client = buildClient(data);
    beginOp();
    showProgress(null, '测试连接中…', '');
    try {
      var page = await client.list({ prefix: '', maxKeys: 1 });
      showProgress(100, '连接成功', '');
      setTimeout(hideProgress, 600); // endOp 统一交给 finally（此前成功路径 endOp 两次）
      toast('连接成功，当前桶可见 ' + page.items.length + ' 个条目', 'ok');
      $('cfgErrors').hidden = true;
    } catch (err) {
      hideProgress();
      diagnoseConnError(err, data);
    } finally {
      endOp();
    }
  }

  /**
   * 解析连接失败原因并给出针对性提示。
   * 注意：浏览器中 CORS 未配置时，fetch 只会抛出无状态码的 TypeError: Failed to fetch，
   * 无法从浏览器端区分「CORS 未配置」与「网络不通」——因此这类错误提示中给出本地诊断手段。
   */
  function diagnoseConnError(err, data) {
    var status = err && err.status;
    var code = err && err.code;

    if (!status && !code) {
      // fetch 网络层失败：浏览器中绝大多数是 CORS 未配置；也可能是 endpoint 域名不可达
      var origin = '';
      try { origin = location.origin; } catch (e) { /* ignore */ }
      renderConnError('浏览器无法访问 R2（无 HTTP 响应）', [
        '最常见原因：存储桶 CORS 未配置或有误。请到 Cloudflare 控制台 → R2 → ' + (data.bucket || '') +
          ' → Settings → Public bucket access → CORS 添加规则：',
        '· AllowedOrigins 填本站域名（不带斜杠）：' + origin,
        '· AllowedMethods：GET / HEAD / PUT / POST / DELETE',
        '· AllowedHeaders：["*"]（必须包含，否则 Authorization 等签名头会被预检拦截）',
        '· 注意：手机访问的域名可能与电脑不同（如 pages.dev 与自定义域），每个入口的域名都要加进 AllowedOrigins。',
        '其次：Endpoint 域名不可达或填错（应形如 https://<account>.r2.cloudflarestorage.com）。',
        '提示：可用本地诊断脚本绕过浏览器验证配置是否正确（见 README「连接失败排查」章节）。'
      ]);
      return;
    }

    if (status === 403 && code === 'SignatureDoesNotMatch') {
      renderConnError('认证失败：签名不匹配（403 SignatureDoesNotMatch）', [
        'Access Key ID 与 Secret Access Key 不匹配，或其中一个复制不完整。',
        '请到 Cloudflare 控制台重新复制令牌，注意 Secret 只显示一次，需在创建时保存。'
      ]);
      return;
    }

    if (status === 403 && code === 'AccessDenied') {
      renderConnError('权限不足（403 AccessDenied）', [
        '令牌有效，但无权访问该桶。检查：',
        '· 创建 API 令牌时是否勾选了该桶（或 "All buckets"）的读写权限；',
        '· 桶名是否正确（区分大小写）：' + (data.bucket || ''),
        '· Endpoint 是否为该桶所属账户的地址。'
      ]);
      return;
    }

    if (status === 404 && (code === 'NoSuchBucket' || code === 'NoSuchKey')) {
      renderConnError('桶不存在或不可见（404 ' + code + '）', [
        '存储桶名称「' + (data.bucket || '') + '」不存在，或该令牌无权看到它。',
        '请到 Cloudflare 控制台确认桶名拼写（区分大小写），并检查令牌权限范围。'
      ]);
      return;
    }

    if (status === 400 && code === 'InvalidAccessKeyId') {
      renderConnError('Access Key ID 无效（400 InvalidAccessKeyId）', [
        '访问密钥 ID 填写有误或令牌已被删除/撤销。请重新创建并复制。'
      ]);
      return;
    }

    // 其他情况：原样展示
    renderConnError('连接失败（HTTP ' + (status || '?') + (code ? ' · ' + code : '') + '）', [
      '原始错误：' + (err && err.message ? err.message : String(err)),
      '请核对上方填写的 Endpoint、Access Key ID、Secret、Bucket 是否与 Cloudflare 控制台一致。'
    ]);
  }

  function renderConfigSelect() {
    var sel = $('cfgSelect');
    var list = cfg.loadAll();
    var active = cfg.getActive();
    sel.innerHTML = '';
    if (!list.length) {
      var opt = document.createElement('option');
      opt.textContent = '（无配置）';
      opt.value = '';
      sel.appendChild(opt);
      return;
    }
    list.forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name || c.bucket;
      sel.appendChild(opt);
    });
    sel.value = active ? active.id : '';
  }

  function exportConfig() {
    var text = cfg.exportJson();
    var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    triggerDownload(blob, 'r2-config-' + new Date().toISOString().slice(0, 10) + '.json');
    toast('配置已导出（包含机密密钥，请妥善保管）', 'ok');
  }

  function importConfig() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = function () {
      var f = input.files && input.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var n = cfg.importJson(String(reader.result));
          renderConfigSelect();
          var active = cfg.getActive();
          if (active) applyConfig(active);
          toast('已导入 ' + n + ' 条配置', 'ok');
        } catch (e) {
          toast('导入失败：' + e.message, 'err');
        }
      };
      reader.readAsText(f);
    };
    input.click();
  }

  /** 粘贴导入：展开/收起输入区 */
  function togglePasteImport() {
    var box = $('pasteImport');
    if (box.hidden) {
      box.hidden = false;
      $('pasteImportText').value = '';
      $('pasteImportText').focus();
    } else {
      box.hidden = true;
    }
  }

  /** 执行粘贴导入 */
  function doPasteImport() {
    var text = $('pasteImportText').value.trim();
    if (!text) {
      toast('请先粘贴导出的 JSON 内容', 'err');
      return;
    }
    try {
      var n = cfg.importJson(text);
      renderConfigSelect();
      var active = cfg.getActive();
      if (active) applyConfig(active);
      $('pasteImport').hidden = true;
      $('pasteImportText').value = '';
      toast('已导入 ' + n + ' 条配置', 'ok');
    } catch (e) {
      toast('导入失败：' + e.message, 'err');
    }
  }

  /** 环境自检：帮助定位手机无法连接的问题（WebCrypto 可用性 / 时间偏差 / 协议） */
  function runEnvCheck() {
    var box = $('envCheckResult');
    var out = [];
    var bad = [];

    // 1. 协议（WebCrypto 需要安全上下文）
    var proto = location.protocol;
    var secure = proto === 'https:' || /^http:\/\/(localhost|127\.0\.0\.1)/.test(location.href);
    out.push((secure ? '✅' : '❌') + ' 访问协议：' + proto + (secure ? '（安全上下文）' : '（非 https！浏览器禁用 WebCrypto，签名无法进行）'));
    if (!secure) bad.push('当前非 https 访问，浏览器会禁用 crypto.subtle，R2 签名必然失败。请改用 https 地址访问本站。');

    // 2. WebCrypto
    var hasSubtle = typeof crypto !== 'undefined' && !!crypto.subtle && typeof crypto.subtle.digest === 'function';
    out.push((hasSubtle ? '✅' : '❌') + ' WebCrypto (crypto.subtle)：' + (hasSubtle ? '可用' : '不可用'));
    if (!hasSubtle) bad.push('浏览器未提供 crypto.subtle（多见于非 https 或极旧浏览器），R2 签名无法进行。');

    // 3. 基础 API
    var hasFetch = typeof fetch === 'function';
    var hasTE = typeof TextEncoder === 'function';
    out.push((hasFetch ? '✅' : '❌') + ' fetch：' + (hasFetch ? '可用' : '不可用'));
    out.push((hasTE ? '✅' : '❌') + ' TextEncoder：' + (hasTE ? '可用' : '不可用'));
    if (!hasFetch) bad.push('浏览器不支持 fetch，请升级浏览器。');
    if (!hasTE) bad.push('浏览器不支持 TextEncoder，签名无法进行（SigV4 依赖它）。');

    // 4. 系统时间（SigV4 签名强依赖本机时间，偏差 >15 分钟会被 R2 拒绝）
    var now = new Date();
    out.push('⏱ 本机当前时间：' + now.toISOString() + '（' + now.toString() + '）');
    out.push('⚠ 若本机时间不准确（与真实时间偏差超过 15 分钟），R2 会拒绝签名请求。手机请检查「自动设置时间」是否开启。');

    // 5. UA
    out.push('📱 浏览器：' + (navigator.userAgent || '未知'));

    var html;
    if (bad.length) {
      html = '<ul class="env-bad">' + bad.map(function (l) { return '<li>' + escapeHtml(l) + '</li>'; }).join('') + '</ul>'
        + '<ul>' + out.map(function (l) { return '<li>' + escapeHtml(l) + '</li>'; }).join('') + '</ul>';
    } else {
      html = '<ul>' + out.map(function (l) { return '<li>' + escapeHtml(l) + '</li>'; }).join('') + '</ul>';
    }
    box.innerHTML = html;
    box.hidden = false;
  }

  function clearLocal() {
    if (!confirm('确定清除本机保存的全部配置吗？\n此操作不可撤销，不会删除 R2 中的任何文件。')) return;
    cfg.clearAll();
    purgeLegacyUsageStorage(); // 清掉旧版本持久化过的容量缓存（现已不再使用）
    currentDir = '';
    items = [];
    bumpItemsVersion();
    selected.clear();
    renderConfigSelect();
    applyConfig(null);
    fillConfigForm(cfg.blank());
    renderTable();
    toast('本机配置已清除', 'ok');
  }

  // ---------- 容量统计与上传限制 ----------
  // 默认总容量上限（GB），用户可在配置表单的 capacityGB 字段调整
  function capacityLimitGB() {
    var v = activeConfig && activeConfig.capacityGB;
    var n = Number(v);
    return (n && n > 0) ? n : 10; // 默认 10GB
  }

  // 容量统计**不做任何持久化缓存**：数字只存在于内存，且每次进入页面（切换配置、
  // 连接恢复、手动点容量条）都必须重新全量扫描一次。
  //   为什么删掉缓存：旧实现把用量写进 localStorage，缓存过期/被清/换设备后
  //   freshForThisConfig 为 false，usedBytes 会被当作 0 直接放行上传，瞬间突破上限。
  //   内存值缺失时的唯一正确行为是「重新统计」，不是「当作 0」。
  // 统计口径含未完成分片上传已占用的容量（见 s3.usageStats）。
  var usage = {
    id: null,        // 该结果属于哪个配置（多账号切换不串台）
    objectBytes: 0,  // 完整对象占用
    partBytes: 0,    // 未完成分片上传占用
    bytes: 0,        // objectBytes + partBytes
    objectCount: 0,
    uploads: 0,      // 未完成的分片上传数
    scannedAt: 0,    // 上次扫描完成时间（0 = 本会话尚未拿到该配置的统计结果）
    scan: null,      // 进行中的扫描 Promise
    scanId: null,    // 进行中的扫描所属配置
    progressCount: null // 进行中扫描的已列举对象数（实时进度显示用；非扫描期为 null）
  };

  /** 本会话按配置缓存的扫描快照（config.id -> usage 数据字段快照）。
   *  只存数字不存 Promise：切换桶时立即恢复上次结果（不再"容量消失"），
   *  同时后台重新扫描校准，完成后原位更新。 */
  var usageCache = {};

  // ---------- 桶内持久容量记录（_meta/usage.json） ----------
  // 每桶一个 ~100 字节、字段恒定不增长的 JSON 记录，用于打开站点/切换桶时秒显容量，
  // 免去每次进站都全量翻页扫描。字段固定 {v, totalBytes, objectCount, updatedAt}，
  // 不存历史、不存明细——它只是"上一次校准点"，精度靠增量维护 + 手动扫描校准兜底。
  var META_KEY = '_meta/usage.json';

  /** 读取 R2 上的容量记录。无记录（首启 404）/ 内容损坏 / 网络失败一律返回 null，
   *  调用方据此回退全量扫描并重新建立记录（自愈），绝不让坏记录挡住正确数字。 */
  async function readUsageRecord() {
    try {
      var res = await s3.get(META_KEY);
      var rec = JSON.parse(await res.blob.text());
      if (rec && rec.v === 1 && isFinite(rec.totalBytes) && rec.totalBytes >= 0 &&
          isFinite(rec.objectCount) && rec.objectCount >= 0) {
        return { totalBytes: Number(rec.totalBytes), objectCount: Number(rec.objectCount), updatedAt: Number(rec.updatedAt) || 0 };
      }
    } catch (e) { /* ignore：全部走自愈路径 */ }
    return null;
  }

  /** 写回容量记录（宽松最后写胜出；失败静默——记录只是加速器，写失败不影响任何功能） */
  function writeUsageRecord(totalBytes, objectCount) {
    var rec = { v: 1, totalBytes: Math.max(0, Math.round(totalBytes)), objectCount: Math.max(0, Math.round(objectCount)), updatedAt: Date.now() };
    try {
      var body = new Blob([JSON.stringify(rec)], { type: 'application/json' });
      s3.put(META_KEY, body).catch(function () { /* ignore */ });
    } catch (e) { /* ignore */ }
  }

  /** 增量写回去抖：一次批量操作内的多次 usageAdjust 合并成一次 PUT。
   *  排队期间切换了桶则丢弃（s3 已指向新桶，旧桶写回是错位的）——
   *  宽松策略：丢一次校准机会没关系，该桶的下一次扫描/写操作会重新写回。 */
  var usageFlushTimer = null;
  var usageFlushId = null;
  function scheduleUsageWrite() {
    usageFlushId = usage.id;
    if (usageFlushTimer) clearTimeout(usageFlushTimer);
    usageFlushTimer = setTimeout(function () {
      usageFlushTimer = null;
      if (!s3 || !activeConfig || usageFlushId === null ||
          activeConfig.id !== usageFlushId || usage.id !== usageFlushId) return;
      writeUsageRecord(usage.bytes, usage.objectCount);
    }, 800);
  }

  /** 旧版本遗留在 localStorage 的容量缓存：一次性清除，不再读写 */
  function purgeLegacyUsageStorage() {
    try {
      var kill = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf('r2em.usage.') === 0) kill.push(k);
      }
      kill.forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) { /* ignore */ }
  }

  function resetUsage() {
    usage.id = null;
    usage.objectBytes = usage.partBytes = usage.bytes = 0;
    usage.objectCount = usage.uploads = 0;
    usage.scannedAt = 0;
    usage.progressCount = null;
  }

  /** 当前内存里的用量是否属于当前配置且已完成过一次扫描（唯一可采信的条件） */
  function usageReady() {
    return !!(activeConfig && usage.id === activeConfig.id && usage.scannedAt);
  }

  function usageLabel(bytes) {
    var gb = bytes / (1024 * 1024 * 1024);
    return (gb >= 0.01 ? gb.toFixed(2) : '0.00') + ' GB';
  }

  /** 写操作后的容量增量维护：仅在本会话已扫过（或已读到记录）该配置时生效。
   *  扫描进行中一律忽略（结果马上会被真实值覆盖，避免把并发窗口算歪）。
   *  deltaCount：对象数增减（上传 +N / 删除 -N），用于维护 R2 记录的 objectCount。
   *  维护后经去抖写回 R2 记录，让其他设备/下次进站也能秒显近似容量。 */
  function usageAdjust(deltaBytes, deltaCount) {
    if (!deltaBytes && !deltaCount) return;
    if (!usageReady() || usage.scanId === activeConfig.id) return;
    if (deltaBytes) {
      usage.bytes = Math.max(0, usage.bytes + deltaBytes);
      usage.objectBytes = Math.max(0, usage.objectBytes + deltaBytes);
    }
    if (deltaCount) usage.objectCount = Math.max(0, usage.objectCount + deltaCount);
    var cached = usageCache[usage.id]; // 同步缓存：切走再切回显示的是含本次增量的数字
    if (cached) {
      cached.bytes = usage.bytes;
      cached.objectBytes = usage.objectBytes;
      cached.objectCount = usage.objectCount;
    }
    renderUsageText();
    scheduleUsageWrite();
  }

  /** 后台容量扫描的取消句柄：切换配置时终止上一个桶还在跑的扫描，
   *  否则新旧两份扫描并行翻页抢连接，浏览和预览都会被拖慢 */
  var usageAbort = null;

  /**
   * 全量精算当前桶用量（完整对象 + 未完成分片）。
   * 不走任何缓存判定：调用即扫描。结果只写内存与 usageCache（按配置 id）。
   * 瞬时错误（网络层/超时/5xx）自动重试一次——大桶要翻很多页，串行翻页途中
   * 单个请求抖动不应让整个统计报废（否则容量条长期停在"未统计"，像消失了一样）。
   * 扫描过程中实时上报已列举对象数，界面显示"统计中… 已扫 N 个对象"。
   * @returns {Promise<number|null>} 扫描得到的字节数；失败或配置已切换返回 null
   */
  function scanUsage() {
    if (!s3 || !activeConfig) return Promise.resolve(null);
    var id = activeConfig.id;
    if (usage.scan && usage.scanId === id) return usage.scan; // 复用进行中的扫描
    // 单飞：同一时刻只保留一份在途扫描，新的开始前终止旧的
    if (usageAbort) { try { usageAbort.abort(); } catch (e) { /* ignore */ } }
    usageAbort = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var signal = usageAbort ? usageAbort.signal : null;
    usage.scanId = id;
    usage.progressCount = null;
    renderUsageText(); // 立即渲染「统计中…」
    var task = withRetry(function () {
      return s3.usageStats({
        signal: signal,
        onProgress: function (count) {
          // 仅当仍是当前扫描时更新进度（切配置后旧回调无权污染新状态）
          if (activeConfig && activeConfig.id === id && usage.scanId === id) {
            usage.progressCount = count;
            renderUsageText();
          }
        }
      });
    }).then(function (res) {
      // 只在「本次扫描仍是当前扫描」时解除占用：切换配置后新扫描已接管状态，
      // 旧回调无权清空，否则容量条会卡在未统计状态
      if (usage.scanId === id) { usage.scan = null; usage.scanId = null; usage.progressCount = null; }
      // 扫描期间用户切换了配置：结果丢弃（避免串台），由新配置的扫描负责渲染
      if (!activeConfig || activeConfig.id !== id) return null;
      usage.id = id;
      usage.objectBytes = res.objectBytes;
      usage.partBytes = res.partBytes;
      usage.bytes = res.total;
      usage.objectCount = res.objectCount;
      usage.uploads = res.uploads;
      usage.scannedAt = Date.now();
      // 记入按桶缓存：切到别的桶再切回来，立即有数字显示（后台还会再校准）
      usageCache[id] = {
        objectBytes: usage.objectBytes, partBytes: usage.partBytes, bytes: usage.bytes,
        objectCount: usage.objectCount, uploads: usage.uploads, scannedAt: usage.scannedAt
      };
      writeUsageRecord(usage.bytes, usage.objectCount); // 校准写回 R2 记录（覆盖漂移/自愈重建）
      renderUsageText();
      alarmIfOverLimit();
      return usage.bytes;
    }).catch(function (err) {
      // 主动取消（切换配置触发 abort）：静默退出，状态已由新扫描接管
      if (err && (err.code === 'Aborted' || err.name === 'AbortError')) return null;
      if (usage.scanId === id) { usage.scan = null; usage.scanId = null; usage.progressCount = null; }
      // 扫描期间已切换配置：本次失败与当前视图无关，不提示也不重渲染
      if (activeConfig && activeConfig.id === id) {
        renderUsageText();
        toast('容量统计失败：' + (err && err.message ? err.message : '请重试'), 'err');
      }
      return null;
    });
    usage.scan = task;
    return task;
  }

  /** 扫描完成后若已超上限，提醒一次（只在该次扫描触发，不重复骚扰） */
  function alarmIfOverLimit() {
    if (!usageReady()) return;
    var limitBytes = capacityLimitGB() * 1024 * 1024 * 1024;
    if (usage.bytes > limitBytes) {
      var detail = '已用 ' + usageLabel(usage.bytes) + ' / 上限 ' + capacityLimitGB() + ' GB';
      if (usage.partBytes > 0) {
        detail += '（含未完成分片 ' + usageLabel(usage.partBytes) + '，可在文件页清理）';
      }
      toast('容量已超出上限：' + detail, 'err');
    }
  }

  function renderUsageText() {
    paintStatus();
    var el = $('connStatus');
    if (el && activeConfig) {
      el.title = usageReady()
        ? '已用 ' + usageLabel(usage.bytes) + ' / 上限 ' + capacityLimitGB() + ' GB（' + activeConfig.bucket + '）'
        : activeConfig.bucket + ' · 容量统计中…';
    }
  }

  /**
   * 上传前校验容量。
   * 关键点：内存里没有该配置的可信用量时，**先 await 一次全量扫描**再判断，
   * 而不是像旧实现那样把缺失值当作 0 放行。扫描失败/超时一律拒绝上传。
   */
  async function checkCapacityForUpload(entries) {
    var addBytes = entries.reduce(function (s, e) {
      return s + (e.body && e.body.size ? e.body.size : 0);
    }, 0);
    var usedBytes = usageReady() ? usage.bytes : null;
    if (usedBytes == null) {
      toast('正在核对桶内容量，请稍候…');
      usedBytes = await scanUsage();
    }
    if (usedBytes == null) {
      toast('上传被拒绝：无法确认当前用量（容量统计未成功）。请检查网络后重试。', 'err');
      return false;
    }
    var limitBytes = capacityLimitGB() * 1024 * 1024 * 1024;
    if (usedBytes + addBytes > limitBytes) {
      var addGB = addBytes / (1024 * 1024 * 1024);
      toast('上传被拒绝：将超出容量上限。当前已用 ' + usageLabel(usedBytes) +
        ' GB，本次需 ' + addGB.toFixed(2) + ' GB，上限 ' + capacityLimitGB() + ' GB。', 'err');
      return false;
    }
    return true;
  }

  // ---------- 目录加载 ----------
  // 竞态防护：快速连续切换目录时，只有最后一次请求的结果允许渲染
  var loadSeq = 0;

  // 目录列表短缓存：前进/后退目录直接秒开，不再重复请求。
  // 任何写操作（上传/删除/移动/改名/新建）都会整体失效；⟳ 强制绕过。
  var dirCache = new Map(); // prefix -> { items, time }
  var DIR_CACHE_TTL = 60 * 1000;
  var DIR_CACHE_MAX = 30;

  function dirCacheGet(prefix) {
    var hit = dirCache.get(prefix);
    if (!hit) return null;
    if (Date.now() - hit.time > DIR_CACHE_TTL) {
      dirCache.delete(prefix);
      return null;
    }
    return hit;
  }
  function dirCachePut(prefix, items, partial) {
    dirCache.set(prefix, { items: items, time: Date.now(), partial: !!partial });
    while (dirCache.size > DIR_CACHE_MAX) {
      dirCache.delete(dirCache.keys().next().value);
    }
    // 同步持久化：下次打开页面直接渲染（SWR）
    idbPut((activeConfig ? activeConfig.id : '') + '|' + prefix,
      { dir: prefix, items: items, time: Date.now(), partial: !!partial });
  }
  function dirCacheClear() {
    dirCache.clear();
    idbDelByConfig(activeConfig ? activeConfig.id : '');
  }

  // ---------- IndexedDB 目录持久缓存（SWR） ----------
  // 内存缓存刷新即丢；IDB 让「再次打开页面」瞬间渲染上次的完整目录，后台再刷新。
  // key = 配置id + '|' + 目录前缀；隐私模式等不可用场景全部静默降级。
  var _idb = { db: null, ok: typeof indexedDB !== 'undefined' };

  function idbOpen() {
    if (_idb.db || !_idb.ok) return Promise.resolve(_idb.db);
    return new Promise(function (resolve) {
      var req;
      try { req = indexedDB.open('r2em-cache', 1); } catch (e) { _idb.ok = false; return resolve(null); }
      req.onupgradeneeded = function () { req.result.createObjectStore('dirs'); };
      req.onsuccess = function () { _idb.db = req.result; resolve(_idb.db); };
      req.onerror = function () { _idb.ok = false; resolve(null); };
    });
  }

  function idbGet(key) {
    return idbOpen().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        try {
          var r = db.transaction('dirs').objectStore('dirs').get(key);
          r.onsuccess = function () { resolve(r.result || null); };
          r.onerror = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
    });
  }

  var _idbWrites = 0;
  function idbPut(key, value) {
    return idbOpen().then(function (db) {
      if (!db) return;
      try {
        var store = db.transaction('dirs', 'readwrite').objectStore('dirs');
        store.put(value, key);
        // 节流清理：每 20 次写扫一遍过期条目（IDB_TTL 7 天前的记录一直躺在磁盘上）
        if ((++_idbWrites % 20) !== 0) return;
        var cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        var req = store.openCursor();
        req.onsuccess = function () {
          var cur = req.result;
          if (!cur) return;
          if (cur.value && cur.value.time && cur.value.time < cutoff) cur.delete();
          cur.continue();
        };
      } catch (e) { /* ignore */ }
    });
  }

  function idbDel(key) {
    return idbOpen().then(function (db) {
      if (!db) return;
      try { db.transaction('dirs', 'readwrite').objectStore('dirs').delete(key); } catch (e) { /* ignore */ }
    });
  }

  /** 删除某配置下的全部目录缓存（结构写操作后调用） */
  function idbDelByConfig(configId) {
    return idbDelPrefix((configId || '') + '|');
  }

  function idbDelPrefix(prefix) {
    return idbOpen().then(function (db) {
      if (!db) return;
      try {
        var store = db.transaction('dirs', 'readwrite').objectStore('dirs');
        var req = store.openCursor();
        req.onsuccess = function () {
          var cur = req.result;
          if (!cur) return;
          if (String(cur.key).indexOf(prefix) === 0) cur.delete();
          cur.continue();
        };
      } catch (e) { /* ignore */ }
    });
  }

  /** 精确失效：只删当前目录与父目录的缓存（其他目录缓存保留，避免全清后全部重新请求） */
  function dirCacheInvalidate(prefix) {
    dirCache.delete(prefix);
    var cfgId = activeConfig ? activeConfig.id : '';
    idbDel(cfgId + '|' + prefix);
    if (prefix) {
      var inner = prefix.slice(0, -1);
      var parent = inner.slice(0, inner.lastIndexOf('/') + 1);
      dirCache.delete(parent);
      idbDel(cfgId + '|' + parent);
    }
  }

  /** 文件夹内容索引按前缀失效：自身、父链、以及所有以其开头的子目录条目 */
  function dirBitsInvalidate(prefix) {
    dirBitsGen++; // 作废在途的 ensureDirBits 扫描（其回调会把已删除条目重新标 ready）
    dirBitsCache.delete(prefix);
    if (prefix) {
      var inner = prefix.slice(0, -1);
      dirBitsCache.delete(inner.slice(0, inner.lastIndexOf('/') + 1));
    }
    dirBitsCache.forEach(function (v, k) {
      if (k.indexOf(prefix) === 0) dirBitsCache.delete(k);
    });
  }

  /** 同一请求失败后自动重试一次。只重试瞬时错误（网络层失败/超时/5xx），
   *  4xx 参数类错误（403 签名错、404 不存在等）重试必然同样失败，白白多一个请求 */
  function withRetry(fn) {
    return fn().catch(function (err) {
      var status = err && err.status;
      var transient = !status || status >= 500 || err.code === 'Timeout';
      // 主动取消（切换配置 abort 旧扫描）不是瞬时故障：重试只会白跑一圈
      if (err && (err.code === 'Aborted' || err.name === 'AbortError')) transient = false;
      if (!transient) throw err;
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          fn().then(resolve, reject);
        }, 600);
      });
    });
  }

  /** 目录加载失败的可重试错误行 */
  function showLoadError(err) {
    items = [];
    var table = document.querySelector('#tableWrap .file-table');
    if (table) table.style.display = IS_MOBILE ? 'block' : 'table';
    EL.gridBody.style.display = 'none';
    EL.emptyState.hidden = true;
    EL.fileBody.innerHTML =
      '<tr class="empty-row"><td colspan="5">读取目录失败：' + escapeHtml(err.message || String(err)) +
      '　<button class="btn" type="button" data-retry>重试</button></td></tr>';
    toast('读取目录失败：' + err.message, 'err');
    updateConnStatus('err', '连接错误');
  }

  var DEBUG_PERF = /[?&]debug=1/.test(location.search);
  function perfMark(name) { if (DEBUG_PERF && performance.mark) performance.mark(name); }
  function perfMeasure(name, startMark, endMark) {
    if (!DEBUG_PERF || !performance.measure) return;
    try {
      performance.measure(name, startMark, endMark);
      var e = performance.getEntriesByName(name).pop();
      console.log('[perf]', name, Math.round(e.duration) + 'ms');
    } catch (err) { /* ignore */ }
  }

  async function loadDir(opts) {
    if (!s3) return;
    opts = opts || {};
    var seq = ++loadSeq;
    var dir = currentDir;
    perfMark('loadDir-start');
    selected.clear();
    updateSelBar();

    // ── 第 0 层：内存缓存。完整缓存直接完成；partial（预取的第一页）渲染后继续取全 ──
    var cached = opts.bypass ? null : dirCacheGet(dir);
    var shown = false;
    if (cached) {
      if (connState === 'err') updateConnStatus('on', connLabel(activeConfig)); // 从失败中恢复
      items = cached.items.filter(function (i) {
        return dir === '' || i.name !== dir;
      });
      bumpItemsVersion();
      selected.clear();
      updateSelBar();
      renderBreadcrumb();
      renderTable();
      prefetchChildDirs(dir, items.filter(function (i) { return i.isFolder; }));
      if (!cached.partial) return; // 完整缓存：完成
      shown = true;                // partial：界面已有列表，下面静默取全
    } else if (!opts.bypass) {
      // ── 第 1 层：IndexedDB 持久缓存（SWR）。命中先渲染上次内容，网络随后刷新 ──
      try {
        var idbHit = await idbGet((activeConfig ? activeConfig.id : '') + '|' + dir);
        if (seq !== loadSeq) return;
        var IDB_TTL = 7 * 24 * 60 * 60 * 1000;
        if (idbHit && idbHit.items && idbHit.items.length !== undefined &&
            !idbHit.partial && Date.now() - idbHit.time < IDB_TTL) {
          if (connState === 'err') updateConnStatus('on', connLabel(activeConfig));
          items = idbHit.items.filter(function (i) { return dir === '' || i.name !== dir; });
          bumpItemsVersion();
          selected.clear();
          updateSelBar();
          renderBreadcrumb();
          renderTable();
          prefetchChildDirs(dir, items.filter(function (i) { return i.isFolder; }));
          shown = true; // 后台刷新不显示"加载中"
        }
      } catch (e) { /* IDB 不可用：走正常加载 */ }
    }

    if (!shown) {
      stopChunkRender(); // 上一次分批渲染的观察器/状态必须在重置列表前解除
      $('fileBody').innerHTML = '<tr class="empty-row"><td colspan="5">加载中…</td></tr>';
      $('emptyState').hidden = true;
    }

    // ── 首屏：只取第一页立即渲染，用户不必等全部翻页（3 页串行 = 白等 3 个 RTT） ──
    var first;
    try {
      first = await withRetry(function () {
        return s3.list({ prefix: dir, maxKeys: 200 });
      });
    } catch (err) {
      if (seq !== loadSeq) return;
      if (shown) {
        // 用户已在看缓存/预取内容：不清空，只提示刷新失败
        toast('目录刷新失败，正在显示缓存内容：' + (err.message || err), 'err');
      } else {
        showLoadError(err);
      }
      return;
    }
    if (seq !== loadSeq) return;
    if (connState === 'err') updateConnStatus('on', connLabel(activeConfig)); // 从失败中恢复
    items = (first.items || []).filter(function (i) {
      return dir === '' || i.name !== dir; // 过滤父文件夹自身的标记对象
    });
    bumpItemsVersion();
    renderBreadcrumb();
    renderTable();
    perfMark('loadDir-firstScreen-done');
    perfMeasure('loadDir:firstScreen', 'loadDir-start', 'loadDir-firstScreen-done');
    prefetchChildDirs(dir, items.filter(function (i) { return i.isFolder; }));

    if (!first.truncated || !first.nextContinuationToken) {
      dirCachePut(dir, first.items || []); // 单页取完：完整数据可入缓存
      return;
    }

    // ── 后台补页：不阻塞界面；失败降级为"已取部分 + 可重试"，不清空已显示内容 ──
    var all = (first.items || []).slice();
    var token = first.nextContinuationToken;
    var bgFailed = null;
    for (var guard = 1; guard < 50; guard++) { // 首页算第 1 页，总上限 50 页（约 5 万条）
      var page;
      try {
        page = await withRetry(function () {
          return s3.list({ prefix: dir, maxKeys: 1000, token: token });
        });
      } catch (err) {
        bgFailed = err;
        break;
      }
      if (seq !== loadSeq) return;
      for (var pi = 0; pi < (page.items || []).length; pi++) all.push(page.items[pi]);
      if (!page.truncated || !page.nextContinuationToken) { token = null; break; }
      token = page.nextContinuationToken;
    }
    if (seq !== loadSeq) return;
    if (token !== null) toast('目录超过 5 万条，仅显示前 5 万条', 'err'); // 翻页上限截断不静默
    if (bgFailed) {
      if (dir === currentDir) {
        items = all.filter(function (i) { return dir === '' || i.name !== dir; });
        bumpItemsVersion();
        renderTable();
        toast('目录未加载完整（已取 ' + all.length + ' 条），点 ⟳ 重试：' + (bgFailed.message || bgFailed), 'err');
      }
      return; // 部分数据不写入缓存（避免半份数据被当完整复用）
    }
    dirCachePut(dir, all);
    if (dir === currentDir) {
      // 补页完成整表重绘会重置 DOM：记住滚动位置与用户已滚动出来的行数，
      // 重绘时一次渲染到该行数并还原位置，避免手快的用户被拽回顶部
      var keepScroll = window.scrollY;
      var keepRows = renderedRowCount;
      items = all.filter(function (i) { return dir === '' || i.name !== dir; });
      bumpItemsVersion();
      renderTable(keepRows);
      window.scrollTo(0, keepScroll);
    }
  }

  /** 预取当前目录下前 5 个子文件夹的第一页：用户点进去时列表已在缓存里，点击即开 */
  function prefetchChildDirs(dir, list) {
    if (!s3) return;
    var mySeq = loadSeq;
    var started = 0;
    for (var i = 0; i < list.length && started < 5; i++) {
      var f = list[i];
      if (!f.isFolder || dirCache.has(f.name)) continue;
      started++;
      (function (folder) {
        s3.list({ prefix: folder.name, maxKeys: NET_LITE ? 100 : 200 }).then(function (page) {
          if (loadSeq !== mySeq) return; // 期间已切换目录/配置：丢弃
          dirCachePut(folder.name, page.items || [], true); // partial：命中后仍需网络取全
        }).catch(function () { /* 预取失败静默 */ });
      })(f);
    }
  }

  function goDir(dir) {
    if (!s3) return;
    currentDir = dir || '';
    searchText = '';
    $('searchInput').value = '';
    $('mSearchInput').value = '';
    $('mSearchRow').hidden = true;
    loadDir();
  }

  function renderBreadcrumb() {
    var bc = $('breadcrumb');
    var parts = currentDir ? currentDir.slice(0, -1).split('/') : [];
    var html = '<span class="crumb-item ' + (parts.length === 0 ? 'current' : '') + '" data-dir="">🏠 根目录</span>';
    var acc = '';
    parts.forEach(function (p, i) {
      acc += safeDecode(p) + '/';
      var last = i === parts.length - 1;
      html += '<span class="crumb-sep">/</span>' +
        '<span class="crumb-item ' + (last ? 'current' : '') + '" data-dir="' + escapeHtml(acc) + '">' +
        escapeHtml(safeDecode(p)) + '</span>';
    });
    bc.innerHTML = html;
    // 面包屑为单行横向滚动，进入深层目录后滚到末尾让当前目录可见
    bc.scrollLeft = bc.scrollWidth;
    // 点击监听在启动时以事件委托绑定（bindBreadcrumbDelegate），渲染零监听器
  }

  function bindBreadcrumbDelegate() {
    $('breadcrumb').addEventListener('click', function (e) {
      var el = e.target.closest('.crumb-item');
      if (el) goDir(el.getAttribute('data-dir') || '');
    });
    $('moveCrumb').addEventListener('click', function (e) {
      var el = e.target.closest('.move-crumb-item');
      if (el) loadMoveFolders(el.getAttribute('data-dir') || '');
    });
    $('moveFolders').addEventListener('click', function (e) {
      var el = e.target.closest('.move-folder');
      if (el) loadMoveFolders(el.getAttribute('data-dir'));
    });
  }

  // ---------- 分区视图 ----------
  // 每个分区独立记忆视图模式（grid/list），存 localStorage
  var SECTION_RE = {
    images: /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i,
    videos: /\.(mp4|webm|mov|avi|mkv|ogv|m4v)$/i,
    audios: /\.(mp3|wav|flac|m4a|aac|ogg|opus)$/i,
    docs: /\.(txt|md|markdown|json|xml|ya?ml|ini|conf|log|csv|tsv|html?|css|js|mjs|cjs|py|jsx|ts|sh|bash|java|c|cpp|h|go|rs|php|rb|sql|toml|properties|cfg|env|pdf|docx?|xlsx?|pptx?)$/i
  };
  var activeSection = 'all';

  // ---------- 文件夹内容索引（按目录） ----------
  // 分区 Tab 里文件夹按「子树中是否包含该类型文件」过滤：
  //   空文件夹只出现在「全部」；只有图片的文件夹出现在「全部 + 相册」，以此类推。
  // 索引只扫当前目录子树（不扫全桶），按目录前缀缓存；
  // 删除/移动/改名整体失效（惰性重建），上传增量合并到所有受影响的目录条目。
  var dirBitsCache = new Map();  // dirPrefix -> { state: 'scanning'|'ready', byFolder: Map<folderName, bits> }
  var dirBitsGen = 0;            // 失效代际：作废进行中的扫描

  function typeBitsFor(name) {
    return {
      images: SECTION_RE.images.test(name),
      videos: SECTION_RE.videos.test(name),
      audios: SECTION_RE.audios.test(name),
      docs: SECTION_RE.docs.test(name)
    };
  }

  /** 确保当前目录的子树类型索引存在（不存在则后台扫描 currentDir 子树） */
  var DIR_BITS_MAX = 20;
  function ensureDirBits(dir) {
    var entry = dirBitsCache.get(dir);
    if (entry) return entry;
    // LRU 上限：浏览几十个目录后不至于无界累积（Map 保持插入序，淘汰最旧）
    while (dirBitsCache.size >= DIR_BITS_MAX) {
      dirBitsCache.delete(dirBitsCache.keys().next().value);
    }
    entry = { state: 'scanning', byFolder: new Map() };
    dirBitsCache.set(dir, entry);
    var gen = ++dirBitsGen;
    var map = entry.byFolder;
    // 流式累加：不落整棵子树数组
    s3.listEach(dir, function (pageItems) {
      for (var i = 0; i < pageItems.length; i++) {
        var item = pageItems[i];
        if (item.isFolder) continue; // 文件夹标记不贡献类型位
        var rel = item.name.slice(dir.length);
        var slash = rel.indexOf('/');
        if (slash === -1) continue;  // 直接位于当前目录的文件：不进入任何子文件夹
        var child = rel.slice(0, slash + 1);
        var bits = typeBitsFor(item.name);
        var cur = map.get(child);
        if (!cur) { cur = { images: false, videos: false, audios: false, docs: false }; map.set(child, cur); }
        if (bits.images) cur.images = true;
        if (bits.videos) cur.videos = true;
        if (bits.audios) cur.audios = true;
        if (bits.docs) cur.docs = true;
      }
    }).then(function () {
      if (gen !== dirBitsGen) return; // 期间发生过结构写操作：本轮作废
      entry.state = 'ready';
      scheduleRenderTable(); // 索引就绪：重渲染以应用过滤
    }).catch(function () {
      if (gen !== dirBitsGen) return;
      dirBitsCache.delete(dir); // 扫描失败：下次进入分区重试
    });
    return entry;
  }

  /** 求一个 key 的全部祖先目录前缀（含根 ''），如 'a/b/c.txt' → ['', 'a/', 'a/b/'] */
  function ancestorDirsOf(key) {
    var out = [''];
    var acc = '';
    var rest = key;
    var idx;
    while ((idx = rest.indexOf('/')) !== -1) {
      acc += rest.slice(0, idx + 1);
      out.push(acc);
      rest = rest.slice(idx + 1);
    }
    return out;
  }

  /** 上传后增量合并：把成功 key 的类型位加进其祖先目录的缓存条目（就绪时），不重扫。
   *  只沿 key 的祖先链更新（O(深度)），不遍历整个缓存 */
  function folderIndexAddKeys(keys) {
    keys.forEach(function (key) {
      ancestorDirsOf(key).forEach(function (dir) {
        var entry = dirBitsCache.get(dir);
        if (!entry || entry.state !== 'ready') return;
        var rel = key.slice(dir.length);
        var slash = rel.indexOf('/');
        if (slash === -1) return; // 直接位于该目录的文件不影响子文件夹位
        var child = rel.slice(0, slash + 1);
        var bits = typeBitsFor(key);
        var cur = entry.byFolder.get(child);
        if (!cur) { cur = { images: false, videos: false, audios: false, docs: false }; entry.byFolder.set(child, cur); }
        if (bits.images) cur.images = true;
        if (bits.videos) cur.videos = true;
        if (bits.audios) cur.audios = true;
        if (bits.docs) cur.docs = true;
      });
    });
  }

  /** 分区过滤（在搜索过滤基础上按类型过滤）；文件夹按当前目录索引中的子树内容位过滤 */
  function sectionItems(list) {
    if (activeSection === 'all' || !SECTION_RE[activeSection]) return list;
    var re = SECTION_RE[activeSection];
    var bit = activeSection;
    var entry = dirBitsCache.get(currentDir);
    return list.filter(function (i) {
      if (!i.isFolder) return re.test(i.name);
      // 索引未就绪（未扫描/扫描中/失败）：先全部显示，扫描完成后自动收紧
      if (!entry || entry.state !== 'ready') return true;
      // 索引键是「相对当前目录的子前缀」（ensureDirBits 写入 'b/'），查询也必须用相对形式
      var child = i.name.slice(currentDir.length);
      var info = entry.byFolder.get(child);
      return !!(info && info[bit]);
    });
  }

  function viewModeFor(section) {
    var key = 'r2em.view.' + section;
    try {
      var saved = localStorage.getItem(key);
      if (saved) return saved;
    } catch (e) { /* ignore */ }
    // 手机端相册/视频默认网格（缩略图更直观），其余分区默认列表
    if (IS_MOBILE && (section === 'images' || section === 'videos')) return 'grid';
    return 'list';
  }
  function setViewMode(section, mode) {
    try { localStorage.setItem('r2em.view.' + section, mode); } catch (e) { /* ignore */ }
  }

  // 过滤+排序结果缓存：一次渲染链路（renderTable/syncCheckAll/全选）只算一次，
  // items/搜索词/分区/索引就绪状态任一变化才失效
  var _visibleCache = { key: '', data: null };
  var itemsVersion = 0;
  var itemMap = new Map(); // name -> item（点击查找 O(1)，items 变化时重建）
  function bumpItemsVersion() {
    itemsVersion++;
    _visibleCache.key = '';
    itemMap = new Map();
    for (var i = 0; i < items.length; i++) itemMap.set(items[i].name, items[i]);
  }

  function visibleItems() {
    var bitsEntry = dirBitsCache.get(currentDir);
    var key = itemsVersion + '|' + searchText + '|' + activeSection + '|' +
      (bitsEntry ? bitsEntry.state : 'none') + '|' + currentDir;
    if (_visibleCache.key === key && _visibleCache.data) return _visibleCache.data;
    var filtered = items;
    if (searchText) {
      var q = searchText.toLowerCase();
      filtered = filtered.filter(function (i) { return i.name.toLowerCase().indexOf(q) !== -1; });
    }
    // 文件夹在前、按名排序（不用 localeCompare：ICU collator 大列表极慢）
    var result = sectionItems(filtered).slice().sort(function (a, b) {
      if (!!a.isFolder !== !!b.isFolder) return a.isFolder ? -1 : 1;
      var x = a.name, y = b.name;
      return x === y ? 0 : (x < y ? -1 : 1);
    });
    _visibleCache = { key: key, data: result };
    return result;
  }

  /** 渲染单个网格卡片（相册/视频/文档/音频分区用；手机端无内联按钮，操作走 ⋯） */
  function gridCardHTML(item, section) {
    var icon = iconFor(item);
    var link = publicLink(item.name);
    var thumb;
    // 相册网格：显示图片封面。公共链接（cdn-cgi 缩放/原图）优先；
    // 未配置公共链接时输出无 src 的占位 img（data-presign=对象名），
    // 由 fillPresignThumbs 在插入 DOM 后异步填预签名直链——私有桶也有封面
    if (section === 'images' && IMAGE_RE.test(item.name)) {
      if (link) {
        thumb = '<img loading="lazy" decoding="async" src="' + escapeHtml(thumbLink(item.name) || link) + '"' +
          thumbSrcset(item.name) +
          ' data-full="' + escapeHtml(link) + '"' + THUMB_ONERROR + ' alt="">';
      } else {
        thumb = '<img loading="lazy" decoding="async" data-presign="' + escapeHtml(item.name) + '"' + THUMB_ONERROR + ' alt="">';
      }
    } else if (section === 'videos' && !item.isFolder && VIDEO_RE.test(item.name)) {
      // 视频首帧封面：统一用 img 展示。优先读 IndexedDB 缓存（秒出），
      // 未命中进视口后用预签名直链截一帧首图并永久缓存（见 fillPresignThumbs）。
      // 不再渲染常驻 <video> 元素：会持续占用媒体连接，与预览播放抢带宽。
      // 刷新封面入口在 ⋯ 动作面板（openActionSheet），不占用封面视觉空间
      thumb = '<img loading="lazy" decoding="async" data-vthumb="' + escapeHtml(item.name) +
        '" data-vsize="' + (item.size || 0) + '" alt="">';
    } else {
      thumb = '<span class="grid-icon">' + icon.text + '</span>';
    }
    var label = baseName(item.name);
    var size = item.isFolder ? '文件夹' : humanSize(item.size);
    var sel = selected.has(item.name) ? ' selected' : '';
    var checked = selected.has(item.name) ? ' checked' : '';
    // 桌面网格：视频卡片操作行加「刷新封面」，与 ⋯ 菜单同一入口（refreshVideoThumb）
    var vRefreshBtn = (section === 'videos' && !item.isFolder && VIDEO_RE.test(item.name))
      ? '<button class="row-btn" data-act="vrefresh">刷新封面</button>'
      : '';

    if (IS_MOBILE) {
      return '<div class="grid-card' + sel + '" data-name="' + escapeHtml(item.name) + '">' +
        '<div class="grid-thumb" data-open="' + escapeHtml(item.name) + '">' + thumb + '</div>' +
        '<label class="grid-check"><input type="checkbox" data-check' + checked + '></label>' +
        '<button type="button" class="m-gmore" data-act="menu">⋯</button>' +
        '<div class="grid-meta" data-open="' + escapeHtml(item.name) + '">' +
          '<div class="grid-name" title="' + escapeHtml(item.name) + '">' + escapeHtml(label) + '</div>' +
          '<div class="grid-sub">' + escapeHtml(size) + '</div>' +
        '</div>' +
      '</div>';
    }
    return '<div class="grid-card' + sel + '" data-name="' + escapeHtml(item.name) + '">' +
      '<div class="grid-thumb" data-open="' + escapeHtml(item.name) + '">' + thumb + '</div>' +
      '<div class="grid-meta">' +
        '<div class="grid-name" title="' + escapeHtml(item.name) + '" data-open="' + escapeHtml(item.name) + '">' + escapeHtml(label) + '</div>' +
        '<div class="grid-sub">' + escapeHtml(size) + '</div>' +
      '</div>' +
      '<label class="grid-check"><input type="checkbox" data-check' + checked + '></label>' +
      '<div class="grid-actions">' +
        '<button class="row-btn" data-act="preview">预览</button>' +
        vRefreshBtn +
        '<button class="row-btn" data-act="download">下载</button>' +
        '<button class="row-btn" data-act="copylink">链接</button>' +
        '<button class="row-btn" data-act="move">移动</button>' +
        '<button class="row-btn danger" data-act="delete">删除</button>' +
      '</div>' +
    '</div>';
  }

  /** 桌面列表行：单行紧凑（原始文件名/类型等进 title 提示，不再占第二行） */
  function desktopRowHTML(item) {
    var icon = iconFor(item);
    var meta = item.meta || {};
    var extra = '';
    if (!item.isFolder && meta['filename'] && meta['filename'] !== item.name) {
      extra = meta['filename'];
    } else if (!item.isFolder && meta['content-type']) {
      extra = meta['content-type'];
    }
    var checked = selected.has(item.name) ? ' checked' : '';
    var rowCls = selected.has(item.name) ? 'selected' : '';
    var actions;
    if (item.isFolder) {
      actions = '<button class="row-btn" data-act="move">移动</button>' +
        '<button class="row-btn" data-act="rename">重命名</button>' +
        '<button class="row-btn danger" data-act="delete">删除</button>';
    } else {
      actions = '<button class="row-btn" data-act="preview">预览</button>' +
        '<button class="row-btn" data-act="download">下载</button>' +
        '<button class="row-btn" data-act="copylink">链接</button>' +
        '<button class="row-btn" data-act="move">移动</button>' +
        '<button class="row-btn" data-act="rename">重命名</button>' +
        '<button class="row-btn danger" data-act="delete">删除</button>';
    }
    var title = baseName(item.name) + (extra ? ' · ' + extra : '');
    return '<tr class="' + rowCls + '" data-name="' + escapeHtml(item.name) + '">' +
      '<td class="col-check"><input type="checkbox" data-check' + checked + '></td>' +
      '<td><div class="name-cell" data-open="' + escapeHtml(item.name) + '" title="' + escapeHtml(title) + '">' +
        '<span class="icon ' + icon.cls + '">' + icon.text + '</span>' +
        '<span class="label">' + escapeHtml(baseName(item.name)) + '</span>' +
      '</div></td>' +
      '<td class="col-size">' + (item.isFolder ? '—' : humanSize(item.size)) + '</td>' +
      '<td class="col-date">' + (item.lastModified ? fmtDate(item.lastModified) : '—') + '</td>' +
      '<td class="col-act"><div class="row-actions">' + actions + '</div></td>' +
      '</tr>';
  }

  /** 手机列表行：缩略图/图标 + 名称 + 大小·时间，操作收进 ⋯ 动作面板 */
  function mobileRowHTML(item) {
    var icon = iconFor(item);
    var link = publicLink(item.name);
    var thumb = '';
    if (!item.isFolder && IMAGE_RE.test(item.name)) {
      if (link) {
        thumb = '<img class="m-thumb" loading="lazy" decoding="async" src="' + escapeHtml(thumbLink(item.name) || link) +
          '" data-full="' + escapeHtml(link) + '"' + THUMB_ONERROR + ' alt="">';
      } else {
        thumb = '<img class="m-thumb" loading="lazy" decoding="async" data-presign="' + escapeHtml(item.name) + '"' + THUMB_ONERROR + ' alt="">';
      }
    }
    // 视频不生成列表封面：列表行视觉空间小、进出频繁，截帧成本不划算，只留网格封面
    var metaTxt = item.isFolder ? '文件夹' : humanSize(item.size);
    if (item.lastModified) metaTxt += ' · ' + fmtDateCached(item);
    var checked = selected.has(item.name) ? ' checked' : '';
    return '<tr class="m-row' + (selected.has(item.name) ? ' selected' : '') + '" data-name="' + escapeHtml(item.name) + '">' +
      '<td colspan="5"><div class="m-row-inner">' +
        '<label class="m-check"><input type="checkbox" data-check' + checked + '></label>' +
        '<div class="m-ic ' + icon.cls + '">' + icon.text + thumb + '</div>' +
        '<div class="m-main" data-open="' + escapeHtml(item.name) + '">' +
          '<div class="m-name">' + escapeHtml(baseName(item.name)) + '</div>' +
          '<div class="m-meta">' + escapeHtml(metaTxt) + '</div>' +
        '</div>' +
        '<button type="button" class="m-more" data-act="menu">⋯</button>' +
      '</div></td></tr>';
  }

  // ---------- 滚动分批渲染 ----------
  // 大目录一次构建上千行 DOM 在手机上明显卡顿：先渲染首批，
  // 滚动接近底部时追加下一批，直至渲染完。
  var RENDER_CHUNK_MOBILE = 120;
  var RENDER_CHUNK_DESKTOP = 300;
  var chunkState = null;        // { data, index, grid, section }
  var chunkScrollHandler = null;
  var renderedRowCount = 0;     // 当前 DOM 里已渲染的条目数（分批渲染时随追加递增）

  function chunkSize() { return IS_MOBILE ? RENDER_CHUNK_MOBILE : RENDER_CHUNK_DESKTOP; }

  function stopChunkRender() {
    if (chunkScrollHandler) {
      window.removeEventListener('scroll', chunkScrollHandler);
      chunkScrollHandler = null;
    }
    chunkState = null;
  }

  var _htmlBuf = []; // 复用缓冲区：批量渲染零中间数组分配
  function buildItemsHTML(list, grid, section) {
    _htmlBuf.length = 0;
    if (grid) {
      for (var i = 0; i < list.length; i++) _htmlBuf.push(gridCardHTML(list[i], section));
    } else {
      var fn = IS_MOBILE ? mobileRowHTML : desktopRowHTML;
      for (var j = 0; j < list.length; j++) _htmlBuf.push(fn(list[j]));
    }
    return _htmlBuf.join('');
  }

  function appendNextChunk() {
    var st = chunkState;
    if (!st) return;
    var slice = st.data.slice(st.index, st.index + chunkSize());
    var container = st.grid ? $('gridBody') : $('fileBody');
    var sentinel = container.querySelector('.chunk-sentinel');
    if (slice.length) {
      var html = buildItemsHTML(slice, st.grid, st.section);
      if (sentinel) sentinel.insertAdjacentHTML('beforebegin', html);
      else container.insertAdjacentHTML('beforeend', html);
      fillPresignThumbs(container);
      st.index += slice.length;
      renderedRowCount = st.index;
    }
    if (st.index >= st.data.length) {
      if (sentinel) sentinel.remove();
      stopChunkRender();
    }
  }

  /** 哨兵接近视口（600px 内）即追加下一批。
   *  用滚动事件 + 位置检查而非 IntersectionObserver：实测部分引擎对
   *  大表格深层元素的 IO 通知不可靠（连初始回调都不投递），滚动检查是确定性的 */
  function startChunkRender(data, grid, startIndex) {
    var container = grid ? $('gridBody') : $('fileBody');
    var first = data.slice(0, startIndex || chunkSize());
    container.insertAdjacentHTML('beforeend', buildItemsHTML(first, grid, activeSection));
    fillPresignThumbs(container);
    chunkState = { data: data, index: first.length, grid: grid, section: activeSection };
    renderedRowCount = first.length;
    if (data.length <= first.length) { chunkState = null; return; }
    // 哨兵：标记「还有未渲染数据」的占位行，追加时插到它前面，取完时移除
    var sentinel = document.createElement(grid ? 'div' : 'tr');
    sentinel.className = 'chunk-sentinel' + (grid ? ' chunk-sentinel-grid' : '');
    sentinel.innerHTML = grid ? '加载中…' : '<td colspan="5">加载中…</td>';
    container.appendChild(sentinel);
    chunkScrollHandler = function () {
        if (!chunkState) { stopChunkRender(); return; }
      var c = chunkState.grid ? $('gridBody') : $('fileBody');
      var s = c.querySelector('.chunk-sentinel');
      if (!s) { stopChunkRender(); return; }
      var r = s.getBoundingClientRect();
      if (r.top < innerHeight + 600) appendNextChunk();
    };
    window.addEventListener('scroll', chunkScrollHandler, { passive: true });
    chunkScrollHandler(); // 首屏哨兵已可见时立即追加
  }

  var _renderRaf = null;
  var _renderMinRows = 0;
  /** 高频触发（索引就绪/搜索/全选/分区切换）合并到 rAF，一帧最多渲染一次 */
  function scheduleRenderTable(minRows) {
    _renderMinRows = Math.max(_renderMinRows, minRows || 0);
    if (_renderRaf != null) return;
    _renderRaf = requestAnimationFrame(function () {
      _renderRaf = null;
      var m = _renderMinRows;
      _renderMinRows = 0;
      renderTable(m);
    });
  }

  function renderTable(minRows) {
    var body = $('fileBody');
    var data = visibleItems(); // 过滤+排序已缓存（文件夹在前）

    var emptyMsg = items.length === 0 ? '此文件夹为空' : '没有匹配「' + searchText + '」的条目';
    $('emptyState').hidden = data.length > 0;
    $('emptyState').querySelector('p').textContent = emptyMsg;

    // 分区视图：文件夹过滤需要当前目录的内容索引；没有则后台扫描（只扫 currentDir 子树，完成后自动收紧）
    if (activeSection !== 'all' && data.some(function (i) { return i.isFolder; }) && !dirBitsCache.has(currentDir)) {
      ensureDirBits(currentDir);
    }

    // 网格/列表开关状态
    var grid = activeSection !== 'all' && viewModeFor(activeSection) === 'grid';
    var gridBody = $('gridBody');
    var table = document.querySelector('#tableWrap .file-table');
    // 网格容器必须用 display:grid（内联值会覆盖样式表的 grid 布局声明，
    // 若写成 block 卡片会失去多列、竖向堆成整行宽）
    gridBody.style.display = grid ? 'grid' : 'none';
    if (table) table.style.display = grid ? 'none' : (IS_MOBILE ? 'block' : 'table');
    $('btnViewGrid').classList.toggle('active', grid);
    $('btnViewList').classList.toggle('active', !grid);
    // 手机：单一视图切换按钮（仅非「全部」分区显示）
    var mvt = $('mViewToggle');
    if (mvt) {
      mvt.hidden = !IS_MOBILE || activeSection === 'all';
      mvt.textContent = grid ? '☰' : '▦';
    }

    stopChunkRender();
    var chunk = Math.max(chunkSize(), minRows || 0);
    if (!data.length) {
      body.innerHTML = '';
      gridBody.innerHTML = '';
      renderedRowCount = 0;
    } else if (data.length <= chunk) {
      if (grid) gridBody.innerHTML = buildItemsHTML(data, true, activeSection);
      else body.innerHTML = buildItemsHTML(data, false, activeSection);
      fillPresignThumbs(grid ? gridBody : body);
      renderedRowCount = data.length;
    } else {
      body.innerHTML = '';
      gridBody.innerHTML = '';
      startChunkRender(data, grid, chunk);
    }

    // 注意：这里不再调用 bindTableEvents() —— 行内事件的监听已在启动时通过
    // fileBody 的事件委托统一绑定，避免每次渲染都创建大量监听器导致卡顿。
    $('checkAll').checked = data.length > 0 && data.every(function (i) { return selected.has(i.name); });
    updateSelBar();
  }

  /** 启动时对表格 body 绑定一次事件委托（click / change），
   *  无论有多少行都只有 2 个监听器，避免每次 renderTable 创建大量监听导致卡顿。
   *  同时绑定网格视图容器（分区网格卡片复用同一委托）。 */
  function bindTableDelegate() {
    [ $('fileBody'), $('gridBody') ].forEach(function (container) {
      if (!container) return;

      container.addEventListener('click', function (e) {
        // 长按已弹出面板时，touchend 产生的合成 click 直接忽略
        if (lpFired) { lpFired = false; return; }
        // 复选框由 change 事件处理，避免点击 label 时二次触发
        if (e.target.closest('label')) return;
        // 目录加载失败后的「重试」按钮
        if (e.target.closest('[data-retry]')) {
          loadDir({ bypass: true });
          return;
        }
        var actBtn = e.target.closest('[data-act]');
        if (actBtn) {
          var row = actBtn.closest('[data-name]');
          if (!row) return;
          var rowName = row.getAttribute('data-name');
          var act = actBtn.getAttribute('data-act');
          if (act === 'download') downloadItem(rowName);
          else if (act === 'preview') openFile(rowName);
          else if (act === 'vrefresh') refreshVideoThumb(rowName); // 桌面网格视频卡片：刷新封面
          else if (act === 'copylink') copyPublicLink(rowName);
          else if (act === 'move') openMovePicker([rowName]);
          else if (act === 'rename') renameItem(rowName);
          else if (act === 'delete') deleteItems([rowName]);
          else if (act === 'menu') openActionSheet(rowName);
          return;
        }
        var openEl = e.target.closest('[data-open]');
        if (openEl) {
          var name = openEl.getAttribute('data-open');
          // 手机多选模式下点击条目 = 勾选/取消，不再打开
          if (IS_MOBILE && selectMode) { toggleSelect(name, openEl); return; }
          if (name.slice(-1) === '/') { goDir(name); return; }
          var item = itemMap.get(name);
          if (item && item.isFolder) goDir(name);
          else openFile(name);
          return;
        }
      });

      container.addEventListener('change', function (e) {
        if (!e.target.hasAttribute('data-check')) return;
        var row = e.target.closest('[data-name]');
        if (!row) return;
        var name = row.getAttribute('data-name');
        if (e.target.checked) selected.add(name); else selected.delete(name);
        row.classList.toggle('selected', e.target.checked);
        syncCheckAll();
        updateSelBar();
      });

      // 长按 500ms 弹出动作面板（手机），并屏蔽随后的系统右键菜单
      var lpTimer = null;
      var cancelLP = function () { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
      container.addEventListener('touchstart', function (e) {
        if (!IS_MOBILE || e.touches.length !== 1) return;
        if (e.target.closest('[data-check], [data-act]')) return;
        var row = e.target.closest('[data-name]');
        if (!row) return;
        lpFired = false;
        lpTimer = setTimeout(function () {
          lpTimer = null;
          lpFired = true;
          openActionSheet(row.getAttribute('data-name'));
        }, 500);
      }, { passive: true });
      container.addEventListener('touchmove', cancelLP, { passive: true });
      container.addEventListener('touchend', cancelLP);
      container.addEventListener('touchcancel', cancelLP);
      container.addEventListener('contextmenu', function (e) {
        if (IS_MOBILE) e.preventDefault();
      });
    });
  }

  function syncCheckAll() {
    var data = visibleItems();
    var all = data.length > 0 && data.every(function (i) { return selected.has(i.name); });
    $('checkAll').checked = all;
  }

  function updateSelBar() {
    if (IS_MOBILE) {
      // 手机：底部操作栏在「默认操作」与「批量操作」间切换
      $('mBarDefault').style.display = selectMode ? 'none' : 'flex';
      $('mBarBatch').style.display = selectMode ? 'flex' : 'none';
      $('mSelInfo').textContent = '已选 ' + selected.size + ' 项';
      return;
    }
    var bar = $('batchBar');
    // 直接操作 style.display：hidden 属性会被 .toolbar-left,.toolbar-right 的
    // display:flex 覆盖（旧版 CSS 缓存时尤甚），内联样式优先级最高不受影响
    bar.style.display = selected.size === 0 ? 'none' : 'flex';
    $('selInfo').textContent = '已选 ' + selected.size + ' 项';
  }

  // ---------- 手机独立布局：选择模式 / 底部动作面板 ----------
  function setSelectMode(on) {
    if (selectMode === on) return;
    selectMode = on;
    if (!on) selected.clear();
    document.body.classList.toggle('select-mode', on);
    updateSelBar();
    renderTable();
  }

  /** 多选模式下点击条目：勾选/取消（不打开） */
  function toggleSelect(name, el) {
    var row = el.closest('[data-name]');
    var box = row ? row.querySelector('[data-check]') : null;
    if (selected.has(name)) {
      selected.delete(name);
      if (row) row.classList.remove('selected');
      if (box) box.checked = false;
    } else {
      selected.add(name);
      if (row) row.classList.add('selected');
      if (box) box.checked = true;
    }
    updateSelBar();
  }

  var sheetCtx = null;

  function openSheet(title, actions) {
    overlayOpen('sheet');
    $('mSheetTitle').textContent = title;
    $('mSheetActions').innerHTML = actions.map(function (a, i) {
      return '<button type="button" class="m-sheet-item' + (a.danger ? ' danger' : '') + '" data-idx="' + i + '">' +
        '<span class="m-sheet-ico">' + (a.icon || '') + '</span>' + escapeHtml(a.label) + '</button>';
    }).join('');
    sheetCtx = actions;
    $('mSheet').style.display = 'block';
  }

  function closeSheet(viaPop) {
    overlayClose('sheet', viaPop);
    $('mSheet').style.display = 'none';
    sheetCtx = null;
  }

  /** 单个条目的动作面板（⋯ 按钮 / 长按触发） */
  function openActionSheet(name) {
    var isFolder = name.slice(-1) === '/';
    var actions = [];
    if (isFolder) {
      actions.push({ icon: '📂', label: '打开', run: function () { goDir(name); } });
    } else {
      actions.push({ icon: '👁', label: '预览', run: function () { openFile(name); } });
      actions.push({ icon: '⬇️', label: '下载', run: function () { downloadItem(name); } });
      if (publicLink(name)) {
        actions.push({ icon: '🔗', label: '复制公开链接', run: function () { copyPublicLink(name); } });
      }
      // 视频封面刷新：仅网格视图（封面 img 在 DOM 中）时展示，列表视图没有可反馈的封面
      if (VIDEO_RE.test(name) && findVThumbImg(name)) {
        actions.push({ icon: '🔄', label: '刷新封面', run: function () { refreshVideoThumb(name); } });
      }
    }
    actions.push({ icon: '📁', label: '移动到…', run: function () { openMovePicker([name]); } });
    actions.push({ icon: '✏️', label: '重命名', run: function () { renameItem(name); } });
    actions.push({ icon: '🗑️', label: '删除', danger: true, run: function () { deleteItems([name]); } });
    openSheet(baseName(name), actions);
  }

  /** 上传动作面板：浏览器不支持目录选择（如 iPhone Safari）时自动隐藏该项 */
  function openUploadSheet() {
    var actions = [{ icon: '📄', label: '上传文件', run: function () { $('fileInput').click(); } }];
    if (FOLDER_UPLOAD_SUPPORTED) {
      actions.push({ icon: '📁', label: '上传文件夹', run: function () { $('folderInput').click(); } });
    }
    openSheet('上传到 ' + (baseName(currentDir) || '根目录'), actions);
  }

  $('checkAll').addEventListener('change', function (e) {
    var data = visibleItems();
    if (e.target.checked) data.forEach(function (i) { selected.add(i.name); });
    else data.forEach(function (i) { selected.delete(i.name); });
    scheduleRenderTable();
  });

  var uploadActive = false;
  var activeOpCount = 0; // 独立计数的长操作数：上传中再点下载、下载先完成，不应清零拦截
  function beginOp() { activeOpCount++; }
  function endOp() { activeOpCount = Math.max(0, activeOpCount - 1); }
  var pendingOps = 0; // 进度条可见期间计数（保留，与 activeOpCount 任一 >0 即拦截）
  // 传输/操作进行中意外关闭/刷新页面会中断，交给浏览器原生确认拦截
  window.addEventListener('beforeunload', function (e) {
    if (!uploadActive && activeOpCount <= 0 && pendingOps <= 0) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // 断网/恢复提示；恢复时自动刷新当前目录（此时加载失败会走可重试的错误行）
  window.addEventListener('offline', function () {
    toast('网络已断开，操作可能失败', 'err');
  });
  window.addEventListener('online', function () {
    toast('网络已恢复', 'ok');
    if (s3 && activeConfig && !$('viewFiles').hidden) {
      loadDir({ bypass: true });
      scanUsage(); // 断网期间的用量变化无法感知，恢复后重新全量扫描
    }
  });

  // 全局兜底：未捕获的 Promise 异常以轻提示呈现（节流），避免"静默失败"难排查
  var lastGlobalErr = 0;
  window.addEventListener('unhandledrejection', function (e) {
    var now = Date.now();
    if (now - lastGlobalErr < 4000) return;
    lastGlobalErr = now;
    var reason = e && e.reason;
    var msg = reason && reason.message ? reason.message : String(reason || '未知错误');
    toast('后台出现一个错误：' + msg, 'err');
  });

  // ---------- 上传 ----------
  function entriesFromFiles(fileList, targetDir) {
    var entries = [];
    Array.prototype.forEach.call(fileList, function (f) {
      var key = targetDir + (f.webkitRelativePath && f.webkitRelativePath.indexOf('/') !== -1
        ? f.webkitRelativePath.replace(/^\/+/, '')
        : f.name);
      entries.push({
        key: key,
        body: f,
        extra: { filename: f.name, contentType: f.type || 'application/octet-stream' }
      });
    });
    return entries;
  }

  // 弱网自适应：saveData / 2g 时降低并发与首屏页大小，避免请求风暴
  var NET_LITE = false;
  try {
    var _conn = navigator.connection;
    NET_LITE = !!(_conn && (_conn.saveData || /(?:^|2g)/.test(_conn.effectiveType || '')));
  } catch (e) { /* ignore */ }
  var UPLOAD_CONCURRENCY = NET_LITE ? 2 : 3; // 并发上传数：多个小文件的总耗时显著缩短

  async function uploadEntries(entries) {
    if (!entries.length) return;
    // 保护站内保留目录 _meta/（容量记录等自维护文件存放处）：
    // 上传本地文件夹若恰好含同名目录会覆盖记录，这里一律拦截
    var blocked = entries.filter(function (e) { return String(e.key || '').indexOf('_meta/') === 0; });
    if (blocked.length) {
      entries = entries.filter(function (e) { return String(e.key || '').indexOf('_meta/') !== 0; });
      toast('已跳过 ' + blocked.length + ' 个保留路径文件（_meta/ 为站点自维护目录）', 'err');
      if (!entries.length) return;
    }
    // 容量限制：按桶内真实用量校验（必要时先全量扫描），超出上限禁止上传
    if (!(await checkCapacityForUpload(entries))) return;
    uploadActive = true; // 上传期间拦截意外关闭页面
    beginOp();
    showProgress(0, '准备上传…', '');
    var failed = [];
    var done = 0;
    var cursor = 0;
    var activeNames = [];
    var succeededKeys = [];
    var succeededBytes = 0;
    var uploadError = null;

    async function worker() {
      while (cursor < entries.length) {
        var idx = cursor++;
        var e = entries[idx];
        var thisName = baseName(e.key);
        activeNames.push(thisName);
        var ok = true;
        await new Promise(function (resolve, reject) {
          // 大文件自动分片（单片可重试），小文件走带进度 PUT
          s3.uploadSmart(e.key, e.body, e.extra, function (p) {
            var filePct = p && p.percent != null ? p.percent : 0;
            // 条宽 = 整体进度（已完成文件数 + 当前文件字节进度折算）
            showProgress(
              (done + filePct / 100) / entries.length * 100,
              activeNames.join('、'),
              filePct + '% · 已完成 ' + done + ' / ' + entries.length
            );
          }).then(resolve, reject);
        }).catch(function (err) {
          ok = false;
          uploadError = err;
        });
        if (!ok && s3.head) {
          // 响应丢失（中断发生在对象已写入之后）会"报失败但实际成功"——HEAD 复核：
          // 对象存在且大小与待传文件一致时按成功计
          try {
            var meta = await s3.head(e.key);
            if (meta && meta.size != null && e.body && e.body.size != null &&
                Number(meta.size) === Number(e.body.size)) {
              ok = true;
            }
          } catch (e2) { /* 对象确实不存在：维持失败结论 */ }
        }
        if (!ok && uploadError) {
          var msg = uploadError.message || String(uploadError);
          // 分片上传走 POST（Create/Complete），CORS 未放行 POST 时会表现为 Failed to fetch
          if (/Failed to fetch/i.test(msg)) {
            msg += '（网络中断，或桶的 CORS AllowedMethods 未同时放行 PUT 和 POST）';
          }
          failed.push(e.key + '：' + msg);
        }
        uploadError = null;
        if (ok) {
          succeededKeys.push(e.key);
          if (e.body && e.body.size) succeededBytes += e.body.size;
        }
        activeNames = activeNames.filter(function (n) { return n !== thisName; });
        done++;
        showProgress(done / entries.length * 100, '上传完成', done + ' / ' + entries.length);
      }
    }

    var workers = [];
    for (var w = 0; w < Math.min(UPLOAD_CONCURRENCY, entries.length); w++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    uploadActive = false;
    folderIndexAddKeys(succeededKeys); // 增量更新文件夹内容索引（就绪时），不触发重扫
    hideProgress();
    endOp(); // 与其他调用点一致：hideProgress 先于 endOp（否则会误判"没有其他操作"而提前隐藏）
    if (failed.length) {
      toast('上传完成，失败 ' + failed.length + ' 个：' + failed[0] + (failed.length > 1 ? ' 等' : ''), 'err');
    } else {
      toast('已上传 ' + entries.length + ' 个文件', 'ok');
    }
    usageAdjust(succeededBytes, succeededKeys.length); // 即时修正显示数字并写回 R2 记录；有失败项时残留分片只能靠重扫发现
    if (failed.length) scanUsage(); // 失败场景后台重新全量精算一次，校准碎片占用
    dirCacheInvalidate(currentDir);
    dirBitsInvalidate(currentDir);
    loadDir();
  }

  $('fileInput').addEventListener('change', function (e) {
    var entries = entriesFromFiles(e.target.files, currentDir);
    e.target.value = '';
    uploadEntries(entries);
  });

  // 上传文件夹：保持目录结构（webkitdirectory），递归上传
  $('folderInput').addEventListener('change', function (e) {
    var files = e.target.files;
    e.target.value = '';
    if (!files || !files.length) return;
    var entries = entriesFromFiles(files, currentDir);
    uploadEntries(entries);
  });

  // 拖拽上传。
  // 注意：显示/隐藏必须直接操作 style.display（内联样式优先级最高），
  // 不能只依赖 hidden 属性 —— 旧版 CSS 若缓存了 display:flex 的 .drop-mask，
  // hidden 会被覆盖导致遮罩常驻。
  var dragCounter = 0;
  var showDropMask = function () { $('dropMask').style.display = 'flex'; };
  var hideDropMask = function () { $('dropMask').style.display = 'none'; };
  window.addEventListener('dragenter', function (e) {
    e.preventDefault();
    if (!s3) return;
    dragCounter++;
    showDropMask();
  });
  window.addEventListener('dragleave', function (e) {
    e.preventDefault();
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) hideDropMask();
  });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) {
    e.preventDefault();
    dragCounter = 0;
    hideDropMask();
    if (!s3) return;
    var files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    uploadEntries(entriesFromFiles(files, currentDir));
  });

  // ---------- 预览 ----------
  var IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;
  var VIDEO_RE = /\.(mp4|webm|mov|avi|mkv|ogv|m4v)$/i;
  var AUDIO_RE = /\.(mp3|wav|flac|m4a|aac|ogg|opus)$/i;
  var TEXT_RE = /\.(txt|md|markdown|json|xml|ya?ml|ini|conf|log|csv|tsv|html?|css|js|mjs|cjs|py|jsx|ts|sh|bash|java|c|cpp|h|go|rs|php|rb|sql|toml|properties|cfg|env)$/i;

  function previewKind(name) {
    if (IMAGE_RE.test(name)) return 'image';
    if (VIDEO_RE.test(name)) return 'video';
    if (AUDIO_RE.test(name)) return 'audio';
    if (TEXT_RE.test(name)) return 'text';
    return null;
  }

  /** 打开文件：可预览类型显示模态框，否则直接下载 */
  async function openFile(name) {
    var kind = previewKind(name);
    if (!kind) { downloadItem(name); return; }
    // 预签名直链：纯本地签名计算（零网络请求），无论有没有公共链接都先备好
    var presigned = '';
    try { presigned = await s3.presignedGetUrl(name, { noDisposition: true }); }
    catch (e) { /* 生成失败则无该兜底，最终还有 blob */ }
    var link = publicLink(name);
    // 直链优先级：自定义域公共链接（走 Cloudflare CDN、无限速）> 预签名直链
    // （S3 endpoint 无限速、原生 Range 流式，快进/拖动秒响应）> r2.dev 公共开发域
    // （R2 官方对其限速，seek 会排队，只作备选）。全部失败直接报错——
    // 旧的"整包下载成 blob 再播"兜底已移除（要等 100% 下载，观感就是一直转圈）。
    var primary = (link && activeConfig && activeConfig.customDomain) ? link : (presigned || link);
    var alts = [];
    if (presigned && primary !== presigned) alts.push(presigned);
    if (link && primary !== link) alts.push(link);
    showPreview(kind, primary, name, alts);
  }

  /**
   * 媒体加载失败兜底：依次尝试 altUrls 里的备用直链，全部失败明确报错。
   * 整包下载成 blob 的旧兜底已移除：大文件要等 100% 下载完才能播，
   * 观感就是"一直转圈"——宁可直接失败提示重试，也不做假流式。
   */
  function attachPreviewFallback(kind, name, media, altUrls) {
    var queue = (altUrls || []).slice();
    media.addEventListener('error', function () {
      if (queue.length) {
        media.src = queue.shift();
        if (kind !== 'image') { media.load(); }
        return;
      }
      if (kind === 'image') media.style.display = 'none'; // 露出占位图标
      toast((kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '文件') +
        '直链加载失败，请稍后重试', 'err');
    });
  }

  function showPreview(kind, src, name, altUrls) {
    var el = $('previewModal');
    var body = $('previewBody');
    overlayOpen('preview');
    var html = '';
    var filename = baseName(name);
    if (kind === 'image') {
      html = '<img class="preview-media" src="' + escapeHtml(src) + '" alt="' + escapeHtml(filename) + '">';
    } else if (kind === 'video') {
      // preload=auto：打开预览立即开始缓冲（不等用户点播放），
      // 点下播放时头部大概率已就绪，观感上转圈时间明显缩短
      html = '<video class="preview-media" controls playsinline preload="auto" src="' + escapeHtml(src) + '"></video>';
    } else if (kind === 'audio') {
      html = '<div class="preview-audio"><div class="preview-audio-icon">🎵</div>' +
        '<audio controls preload="auto" src="' + escapeHtml(src) + '"></audio></div>';
    } else if (kind === 'text') {
      html = '<pre class="preview-text">加载中…</pre>';
    }
    body.innerHTML = html;
    $('previewTitle').textContent = filename;
    el.hidden = false;
    el.style.display = 'flex';

    // 图片/视频/音频：加载失败自动换备用直链，最终兜底签名整包下载
    if (kind === 'image' || kind === 'video' || kind === 'audio') {
      attachPreviewFallback(kind, name, body.querySelector(kind === 'image' ? 'img' : kind), altUrls);
    }

    // 文本：需要 fetch 拉取内容（预签名 URL 走 S3 endpoint，其 CORS 是本站运行的必要条件，必然可读）
    if (kind === 'text') {
      var pre = body.querySelector('.preview-text');
      fetchTextPreview(name, pre);
    }
  }

  function fetchTextPreview(name, pre) {
    var RANGE = 262144; // 只取前 256KB：MB 级日志的预览从全量下载变为单次 Range 请求
    var done = function (text, truncated) {
      pre.textContent = truncated
        ? text + '\n\n…（仅预览前 256KB，完整内容请下载）'
        : (text.length > 200000 ? text.slice(0, 200000) + '\n\n…（内容过长已截断）' : text);
    };
    s3.presignedGetUrl(name, { noDisposition: true }).then(function (url) {
      return fetch(url, { headers: { 'Range': 'bytes=0-' + (RANGE - 1) } }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      });
    }).then(function (text) { done(text, text.length >= RANGE); }).catch(function () {
      // 预签名 Range 请求失败（如网关不支持）：回退签名整包下载
      s3.get(name).then(function (res) {
        return res.blob.text();
      }).then(function (text) { done(text, false); }).catch(function (e) {
        pre.textContent = '无法读取文本内容：' + (e && e.message ? e.message : e);
      });
    });
  }

  function closePreview(viaPop) {
    overlayClose('preview', viaPop);
    var el = $('previewModal');
    el.hidden = true;
    el.style.display = 'none';
    // 停止媒体播放并释放资源
    var v = $('previewBody').querySelector('video,audio');
    if (v) {
      var vu = v.src;
      v.pause(); v.removeAttribute('src'); v.load();
      if (vu && vu.indexOf('blob:') === 0) URL.revokeObjectURL(vu); // 释放回退下载的 Blob
    }
    var img = $('previewBody').querySelector('img');
    if (img) { var u = img.src; if (u && u.indexOf('blob:') === 0) URL.revokeObjectURL(u); }
    $('previewBody').innerHTML = '';
  }

  /** 用预签名直链触发浏览器原生下载（流式落盘，不把文件读进内存） */
  function triggerDownloadURL(url, filename) {
    var a = document.createElement('a');
    a.href = url;
    a.download = filename || '';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  // ---------- 下载 ----------
  async function downloadItem(name) {
    if (name.slice(-1) === '/') return;
    beginOp();
    try {
      showProgress(null, '正在准备下载 ' + baseName(name), '');
      var url = await s3.presignedGetUrl(name);
      hideProgress();
      triggerDownloadURL(url, baseName(name));
      toast('已开始下载：' + baseName(name), 'ok');
    } catch (err) {
      hideProgress();
      toast('下载失败：' + err.message, 'err');
    } finally {
      endOp();
    }
  }

  async function downloadSelected() {
    var list = Array.from(selected);
    if (!list.length) return;
    beginOp();
    try {
    showProgress(0, '批量下载', '生成直链中…');
    // 预签名是纯 CPU，先全部并行算完再统一触发下载
    var results = await Promise.all(list.map(function (n) {
      return s3.presignedGetUrl(n).then(function (url) { return { name: n, url: url }; })
        .catch(function () { return { name: n, url: null }; });
    }));
    results.forEach(function (r, i) {
      if (r.url) triggerDownloadURL(r.url, baseName(r.name));
      else toast('下载失败：' + r.name, 'err');
      showProgress((i + 1) / results.length * 100, '批量下载', (i + 1) + ' / ' + results.length);
    });
    hideProgress();
    toast('已提交 ' + list.length + ' 个下载任务', 'ok');
    } finally {
      endOp();
    }
  }

  // ---------- 公开链接 ----------
  function publicLink(name) {
    if (!activeConfig) return null;
    return cfg.publicUrlOf(activeConfig, name);
  }

  // 缩略图加载失败时的回退：先退回原图，再不行就隐藏露出图标。
  // 第一跳必须清掉 srcset：浏览器在有 srcset 时会优先按它选 URL（src 被忽略），
  // 否则 src 已退回原图、srcset 里的缩放变体仍会再次失败触发 error，直接把图隐藏
  var THUMB_ONERROR = ' onerror="if(!this.dataset.f){this.dataset.f=1;this.srcset=\'\';this.src=this.getAttribute(\'data-full\')||this.src;}else{this.style.display=\'none\'}"';

  /**
   * 缩略图地址：配置了自定义域（且经 Cloudflare 代理）时，走 /cdn-cgi/image
   * 服务端缩放（宽 480 / 自动 WebP），流量从整张原图降到几十 KB 级。
   * 未配置自定义域或与公共 URL 不同源时回退原图（R2 开发域名不支持缩放）。
   */
  function thumbLink(name, width) {
    var base = publicLink(name);
    if (!base || !activeConfig || !activeConfig.customDomain) return base;
    var origin = activeConfig.customDomain.replace(/\/+$/, '');
    if (base.indexOf(origin + '/') !== 0) return base;
    // url= 全编码形式：key 含逗号/空格/裸 %/cdn-cgi 片段都不会干扰选项解析
    return origin + '/cdn-cgi/image/width=' + (width || 480) + ',quality=75,format=auto,url=' + encodeURIComponent(base);
  }

  /** srcset：浏览器按视口/DPR 选 240w 或 480w，手机网格流量再降一半 */
  function thumbSrcset(name) {
    if (!thumbLink(name)) return '';
    var u240 = thumbLink(name, 240);
    var u480 = thumbLink(name, 480);
    if (u240 === u480) return '';
    return ' srcset="' + escapeHtml(u240) + ' 240w, ' + escapeHtml(u480) + ' 480w"' +
      ' sizes="(max-width: 768px) 30vw, 300px"';
  }

  // ---------- 视频首帧封面：IndexedDB 缓存 + 截帧 ----------
  // 首帧截一次就永久缓存：键含对象大小，同名覆盖上传（内容变化）后自动失效重截。
  // 截帧源一律用预签名 S3 直链（crossorigin 模式）：站点所有 API 调用都依赖
  // 桶的 CORS 放行，该链路的 ACAO 头有保证，canvas 才不会被污染、能导出 dataURL。
  // 自定义域/r2.dev 的公开链接不带 CORS 头，截帧会 SecurityError，故不作截帧源。
  var VTHUMB_DB = 'r2em-vthumbs';
  var VTHUMB_STORE = 'frames';
  var vthumbDb = null;

  function vthumbDbOpen() {
    if (vthumbDb) return Promise.resolve(vthumbDb);
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(VTHUMB_DB, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(VTHUMB_STORE);
      };
      req.onsuccess = function () { vthumbDb = req.result; resolve(vthumbDb); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function vthumbGet(key) {
    return vthumbDbOpen().then(function (db) {
      return new Promise(function (resolve) {
        var req = db.transaction(VTHUMB_STORE, 'readonly').objectStore(VTHUMB_STORE).get(key);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { resolve(null); };
      });
    }).catch(function () { return null; });
  }

  function vthumbPut(key, dataUrl) {
    return vthumbDbOpen().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(VTHUMB_STORE, 'readwrite');
        tx.objectStore(VTHUMB_STORE).put(dataUrl, key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { resolve(false); };
      });
    }).catch(function () { return false; }); // 缓存失败不影响功能，下次重截
  }

  /**
   * 分析一帧的颜色丰富度：0-100。黑屏/纯色画面接近 0，正常画面几十以上。
   * px：RGBA 像素数组（调用方先缩到 32px 宽采样，开销可忽略）。
   * 指标 = 量化颜色桶数（60%）+ 亮度标准差（40%）：
   * 纯黑/纯白只有 1 个颜色桶、亮度方差为 0；真实画面两者都明显。
   */
  function richnessScore(px) {
    var buckets = {};
    var n = 0, sum = 0, sumSq = 0;
    for (var i = 0; i < px.length; i += 4) {
      var r = px[i], g = px[i + 1], b = px[i + 2];
      var lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += lum; sumSq += lum * lum; n++;
      var key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
      buckets[key] = (buckets[key] || 0) + 1;
    }
    if (!n) return 0;
    var mean = sum / n;
    var std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
    var colorCount = 0;
    for (var k in buckets) if (buckets[k] > n * 0.002) colorCount++; // 滤掉孤点压缩噪声
    var colorScore = Math.min(1, colorCount / 24);
    var lumScore = Math.min(1, std / 28);
    return Math.round((colorScore * 0.6 + lumScore * 0.4) * 100);
  }

  var VTHUMB_RICH_MIN = 35;      // 低于此分视为"颜色单一"画面（黑屏/纯色），换时间点重试
  var VTHUMB_SEEK_TIMEOUT = 4000; // 单次 seek 的超时保护

  /**
   * 截取视频封面帧：从 seed 决定的起点逐个候选时间点尝试，
   * 颜色单一（黑屏/纯色）的画面自动跳过；成功返回 { dataUrl, t }，
   * 所有候选都单一时采用"最丰富"的一帧兜底（有封面总比没有强），失败返回 null。
   * seed 用于"刷新封面"：每次 +1 起点后移 3 秒，多次刷新能轮换出不同画面。
   */
  function captureVideoFrame(url, seed) {
    seed = seed || 0;
    return new Promise(function (resolve) {
      var v = document.createElement('video');
      var timer = setTimeout(function () { finish(best ? best.dataUrl : null, best ? best.t : 0); }, 25000);
      var candidates = [];
      var idx = 0;
      var best = null; // { dataUrl, t, score }

      function finish(dataUrl, t) {
        clearTimeout(timer);
        v.removeEventListener('loadedmetadata', onMeta);
        v.removeEventListener('error', onErr);
        v.onseeked = null;
        try { v.removeAttribute('src'); v.load(); } catch (e) { /* ignore */ }
        resolve(dataUrl ? { dataUrl: dataUrl, t: t } : null);
      }
      function onErr() { finish(null, 0); }
      function onMeta() {
        var d = v.duration;
        var base = seed * 3;
        var pts = [base + 0.1, base + 0.9, base + 2.5, base + 5];
        if (isFinite(d) && d > 0.2) {
          var maxT = d * 0.92;
          pts = pts.filter(function (t) { return t <= maxT; });
          if (!pts.length) pts = [maxT * 0.3, maxT * 0.6, maxT * 0.9]; // 短视频：按时长比例取点
        } else {
          pts = pts.filter(function (t) { return t <= 30; }); // duration 未知（流式封装）：限前 30s
          if (!pts.length) pts = [0.1, 1.5, 5];
        }
        candidates = pts;
        tryNext();
      }
      function tryNext() {
        if (idx >= candidates.length) {
          finish(best ? best.dataUrl : null, best ? best.t : 0);
          return;
        }
        var settle = false;
        var seekGuard = setTimeout(function () {
          if (!settle) { settle = true; analyze(); }
        }, VTHUMB_SEEK_TIMEOUT);
        v.onseeked = function () {
          if (settle) return;
          settle = true;
          clearTimeout(seekGuard);
          requestAnimationFrame(analyze); // 等一帧渲染稳定再取样
        };
        v.currentTime = candidates[idx++];
      }
      function analyze() {
        try {
          var w = v.videoWidth, h = v.videoHeight;
          if (!w || !h) { tryNext(); return; }
          var scale = Math.min(1, 480 / w);
          var cw = Math.round(w * scale), ch = Math.round(h * scale);
          var c = document.createElement('canvas');
          c.width = cw; c.height = ch;
          var ctx = c.getContext('2d');
          ctx.drawImage(v, 0, 0, cw, ch);
          var dataUrl = c.toDataURL('image/jpeg', 0.72);
          // 缩到 32px 宽采样，分析颜色丰富度
          var sw = 32, sh = Math.max(2, Math.round(32 * ch / cw));
          var small = document.createElement('canvas');
          small.width = sw; small.height = sh;
          small.getContext('2d').drawImage(c, 0, 0, sw, sh);
          var score = richnessScore(small.getContext('2d').getImageData(0, 0, sw, sh).data);
          var t = v.currentTime;
          if (!best || score > best.score) best = { dataUrl: dataUrl, t: t, score: score };
          if (score >= VTHUMB_RICH_MIN) { finish(dataUrl, t); return; }
          tryNext(); // 单一画面：换下一个时间点
        } catch (e) {
          finish(best ? best.dataUrl : null, best ? best.t : 0); // canvas 污染等
        }
      }
      v.addEventListener('loadedmetadata', onMeta);
      v.addEventListener('error', onErr);
      v.muted = true;
      v.crossOrigin = 'anonymous'; // 必须：否则 canvas 污染，无法导出
      v.preload = 'metadata';
      v.src = url;
    });
  }

  var vthumbIO = null;

  /** 未命中缓存的视频封面：进视口前 200px 才截帧，避免整屏视频同时发请求 */
  function queueVideoThumbGen(key, name, img, seed) {
    var run = function () { return genVideoThumb(key, name, img, seed); };
    if (typeof IntersectionObserver === 'undefined') { run(); return; }
    if (!vthumbIO) {
      vthumbIO = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          vthumbIO.unobserve(en.target);
          var job = en.target.__vthumbJob;
          if (job) { delete en.target.__vthumbJob; job(); }
        });
      }, { rootMargin: '200px' });
    }
    img.__vthumbJob = run;
    vthumbIO.observe(img);
  }

  /** 生成并应用单个视频封面：seed 决定候选时间点起点（刷新封面时递增） */
  function genVideoThumb(key, name, img, seed) {
    if (!s3) return Promise.resolve();
    return s3.presignedGetUrl(name, { noDisposition: true }).then(function (url) {
      return captureVideoFrame(url, seed);
    }).then(function (r) {
      if (!img.isConnected) return;
      if (r && r.dataUrl) {
        img.src = r.dataUrl;
        img.style.display = '';
        vthumbPut(key, { url: r.dataUrl, t: r.t, seed: seed || 0 }); // 异步写缓存，不等它
      } else {
        img.style.display = 'none'; // 截帧失败：露出底色/图标
      }
    }).catch(function () {
      if (img.isConnected) img.style.display = 'none';
    });
  }

  /** 在当前网格 DOM 中按对象名找视频封面 img（找不到说明不在网格视图） */
  function findVThumbImg(name) {
    var imgs = document.querySelectorAll('img[data-vthumb]');
    for (var i = 0; i < imgs.length; i++) {
      if (imgs[i].getAttribute('data-vthumb') === name) return imgs[i];
    }
    return null;
  }

  /** 单卡片刷新封面（⋯ 菜单触发）：seed+1 换一批候选时间点，成功后覆盖旧缓存 */
  function refreshVideoThumb(name) {
    var img = findVThumbImg(name);
    if (!img || img.__vbusy) return;
    var key = (activeConfig ? activeConfig.id : '') + ':' + name + ':' + (img.getAttribute('data-vsize') || '');
    img.__vbusy = true;
    img.classList.add('v-refreshing');
    var prevSeed = 0;
    vthumbGet(key).then(function (old) {
      if (old && typeof old === 'object' && old.seed) prevSeed = old.seed;
      return genVideoThumb(key, name, img, prevSeed + 1);
    }).then(function () {
      img.__vbusy = false;
      img.classList.remove('v-refreshing');
      if (img.isConnected && img.style.display === 'none') toast('封面截取失败，可再试一次', 'err');
    }).catch(function () {
      img.__vbusy = false;
      if (img.isConnected) img.classList.remove('v-refreshing');
    });
  }

  /**
   * 为封面占位填充内容。
   * 列表渲染是同步的，而签名/缓存读取是异步——渲染时先输出无 src 占位，
   * 插入 DOM 后在这里统一填充。
   * img[data-presign]：图片封面，直接填预签名直链（有原生 loading=lazy）。
   * img[data-vthumb]：视频封面，先查 IndexedDB 缓存，未命中排队截帧。
   */
  function fillPresignThumbs(root) {
    if (!s3 || !root) return;
    var imgs = root.querySelectorAll('img[data-presign]');
    Array.prototype.forEach.call(imgs, function (img) {
      var name = img.getAttribute('data-presign');
      s3.presignedGetUrl(name, { noDisposition: true }).then(function (url) {
        if (img.isConnected) img.src = url;
      }).catch(function () {
        if (img.isConnected) img.style.display = 'none'; // 签名失败：隐藏露出底色
      });
    });

    var vids = root.querySelectorAll('img[data-vthumb]');
    Array.prototype.forEach.call(vids, function (img) {
      var name = img.getAttribute('data-vthumb');
      var size = img.getAttribute('data-vsize') || '';
      var key = (activeConfig ? activeConfig.id : '') + ':' + name + ':' + size;
      vthumbGet(key).then(function (cached) {
        if (!img.isConnected) return;
        if (cached) {
          // 兼容两种条目：旧缓存是纯 dataURL 字符串；新缓存是 { url, t, seed }
          img.src = typeof cached === 'string' ? cached : cached.url;
          img.style.display = '';
          return; // 缓存命中：毫秒级显示，零网络
        }
        queueVideoThumbGen(key, name, img, 0);
      });
    });
  }

  function copyPublicLink(name) {
    var link = publicLink(name);
    if (!link) {
      toast('该配置未填写「R2 公共开发 URL」或「自定义域」，无法生成公开链接。\n可改为「下载」。', 'err');
      return;
    }
    copyText(link);
  }

  function copySelectedLinks() {
    var list = Array.from(selected);
    var links = list.map(function (n) { return publicLink(n); });
    if (links.some(function (l) { return !l; })) {
      toast('部分条目无法生成公开链接：请先填写「R2 公共开发 URL」或「自定义域」', 'err');
      return;
    }
    copyText(links.join('\n'));
  }

  // ---------- 删除 ----------
  // 删除/移动都是「复制+删除」的多请求操作，加锁防止连点导致重复执行
  var opBusy = false;

  /** 小型 worker 池：以固定并发执行异步任务（复制分片等）。
   *  onItemFail 非空时：首个失败后停止派发新任务，等待在途任务结束后整体抛出 */
  async function runPool(taskList, workerFn, concurrency, onEachDone) {
    concurrency = concurrency || 4;
    var cursor = 0;
    var firstError = null;
    async function worker() {
      while (cursor < taskList.length) {
        if (firstError) return;
        var idx = cursor++;
        try {
          await workerFn(taskList[idx], idx);
          if (onEachDone) onEachDone();
        } catch (err) {
          firstError = firstError || err;
          return;
        }
      }
    }
    var workers = [];
    for (var w = 0; w < Math.min(concurrency, taskList.length); w++) workers.push(worker());
    await Promise.all(workers);
    if (firstError) throw firstError;
  }

  async function deleteItems(names) {
    if (!names.length) return;
    if (opBusy) {
      toast('有操作正在进行中，请稍候', 'err');
      return;
    }
    var hasFolder = names.some(function (n) { return n.slice(-1) === '/'; });
    var desc = names.length === 1
      ? (hasFolder
        ? '确定删除文件夹「' + baseName(names[0]) + '」及其全部内容吗？'
        : '确定删除「' + baseName(names[0]) + '」吗？')
      : '确定删除选中的 ' + names.length + ' 项吗？' + (hasFolder ? '（含文件夹的全部内容）' : '');
    if (!confirm(desc + '\n此操作不可撤销。')) return;
    opBusy = true;
    beginOp();
    try {
      showProgress(0, '正在删除…', '');
      // 文件夹递归展开：只删占位对象会让子树内容全部残留（表现为"删完了但文件夹还在"）。
      // 展开时流式累加子树字节数——容量扣减因此对文件夹也精确，无需再标记"可能不准"。
      var allKeys = [];
      var seen = Object.create(null);
      var removedBytes = 0;
      for (var ni = 0; ni < names.length; ni++) {
        var name = names[ni];
        if (name.slice(-1) === '/') {
          await s3.listEach(name, function (subItems) {
            for (var si = 0; si < subItems.length; si++) {
              var k = subItems[si].name;
              if (!seen[k]) { seen[k] = 1; allKeys.push(k); }
              removedBytes += Number(subItems[si].size) || 0;
            }
          });
          if (!seen[name]) { seen[name] = 1; allKeys.push(name); } // 文件夹占位标记
        } else {
          if (!seen[name]) { seen[name] = 1; allKeys.push(name); }
          var hit = itemMap.get(name);
          removedBytes += hit ? (Number(hit.size) || 0) : 0;
        }
      }
      // NoSuchKey 不算失败：删除的期望终态就是「key 不存在」，
      // 隐式文件夹（只有内容、没有 0 字节占位标记）删标记时必然 404
      var failed = [];
      var deletedCount = 0;
      for (var i = 0; i < allKeys.length; i += 200) {
        var batch = allKeys.slice(i, i + 200);
        var result = await s3.remove(batch, function (cur, total) {
          showProgress(cur / total * 100, '正在删除…', cur + ' / ' + total);
        });
        deletedCount += result.deleted.length;
        (result.failed || []).forEach(function (f) {
          if (f.code !== 'NoSuchKey') failed.push(f);
        });
      }
      hideProgress();
      usageAdjust(-removedBytes, -deletedCount); // 子树字节数在展开时已知，精确扣减并写回 R2 记录
      selected.clear();
      if (failed.length) toast('删除完成，失败 ' + failed.length + ' 项：' + baseName(failed[0].key), 'err');
      else toast('已删除 ' + deletedCount + ' 项', 'ok');
      dirCacheInvalidate(currentDir);
      dirBitsInvalidate(currentDir);
      loadDir();
    } finally {
      opBusy = false;
      endOp();
    }
  }

  // ---------- 移动（跨目录） ----------
  /**
   * 批量移动到目标目录。底层与重命名相同：服务端 CopyObject 复制后删除原件，
   * 不经过浏览器中转。文件夹会递归移动整棵子树。
   */
  async function moveItems(names, targetDir) {
    if (opBusy) {
      toast('有操作正在进行中，请稍候', 'err');
      return;
    }
    var valid = [];
    var blocked = [];
    names.forEach(function (name) {
      var isFolder = name.slice(-1) === '/';
      var dest = targetDir + baseName(name) + (isFolder ? '/' : '');
      if (dest === name) return; // 原地不动，跳过
      if (isFolder && targetDir.indexOf(name) === 0) {
        blocked.push(baseName(name));
        return;
      }
      valid.push({ name: name, dest: dest, isFolder: isFolder });
    });
    if (blocked.length) {
      toast('以下文件夹不能移动到其自身内部：' + blocked.join('、'), 'err');
    }
    if (!valid.length) return;
    opBusy = true;
    beginOp();
    try {
      showProgress(0, '正在移动…', '');
      var done = 0;
      var failed = [];
      for (var i = 0; i < valid.length; i++) {
        var v = valid[i];
        try {
          if (v.isFolder) {
            // 流式收集子树（不落完整对象数组）；objectKeys 供并发复制，allKeys 供删除
            var allKeys = [];
            var objectKeys = [];
            await s3.listEach(v.name, function (items) {
              for (var i = 0; i < items.length; i++) {
                allKeys.push(items[i].name);
                if (!items[i].isFolder) objectKeys.push(items[i].name);
              }
            });
            // 并发复制（4 路）；失败时回滚已复制的目标 key（源目录不动），
            // 避免"新目录有部分文件、旧目录还在"的半成品状态
            var copied = 0;
            var copiedDest = [];
            try {
              await runPool(objectKeys, async function (srcKey) {
                var destKey = v.dest + srcKey.slice(v.name.length);
                await s3.copy(srcKey, destKey);
                copiedDest.push(destKey);
                copied++;
                // 条宽 = 整体进度（当前文件夹复制比例折算到全部待移动项）
                showProgress(
                  (done + copied / objectKeys.length) / valid.length * 100,
                  baseName(v.name),
                  '复制中 ' + copied + ' / ' + objectKeys.length
                );
              }, 4);
            } catch (copyErr) {
              if (copiedDest.length) {
                try { await deleteKeys(copiedDest); } catch (e) { /* 回滚失败：保留现场供用户检查 */ }
              }
              throw copyErr;
            }
            // 空文件夹没有子对象可复制，需在目标位置写入目录占位对象，否则文件夹会消失
            if (!objectKeys.length) await s3.mkdir(v.dest);
            try {
              await deleteKeys(allKeys);
            } catch (err) {
              // 复制已成功但清理源失败：目标完整、源残留，提示用户手动清理而非静默
              toast('已复制到目标位置，但删除源文件夹失败：' + (err.message || err), 'err');
            }
          } else {
            await s3.copy(v.name, v.dest);
            await deleteKeys([v.name]);
          }
          done++;
          showProgress(done / valid.length * 100, '已移动 ' + baseName(v.name), done + ' / ' + valid.length);
        } catch (err) {
          failed.push(baseName(v.name) + '：' + (err && err.message ? err.message : err));
          done++;
          showProgress(done / valid.length * 100, '失败 ' + baseName(v.name), done + ' / ' + valid.length);
        }
      }
      hideProgress();
      if (failed.length) {
        toast('移动完成，失败 ' + failed.length + ' 项：' + failed[0] + (failed.length > 1 ? ' 等' : ''), 'err');
      } else {
        toast('已移动 ' + done + ' 项到「' + (baseName(targetDir) || '根目录') + '」', 'ok');
      }
      selected.clear();
      updateSelBar();
      dirCacheInvalidate(currentDir);
      if (targetDir && targetDir !== currentDir) dirCacheInvalidate(targetDir); // 目标目录列表也变了
      dirBitsInvalidate(currentDir);
      loadDir();
    } finally {
      opBusy = false;
      endOp();
    }
  }

  // ---------- 移动目标文件夹选择器 ----------
  var moveState = { names: [], target: '' };

  function openMovePicker(names) {
    if (!s3) return;
    if (!names.length) {
      toast('请先勾选要移动的文件', 'err');
      return;
    }
    overlayOpen('move');
    moveState = { names: names, target: '' };
    $('moveModal').style.display = 'flex';
    loadMoveFolders('');
  }

  function closeMovePicker(viaPop) {
    overlayClose('move', viaPop);
    $('moveModal').style.display = 'none';
    moveState = { names: [], target: '' };
  }

  function renderMoveCrumb() {
    var crumb = $('moveCrumb');
    var parts = moveState.target ? moveState.target.slice(0, -1).split('/') : [];
    var html = '<span class="move-crumb-item ' + (parts.length === 0 ? 'current' : '') + '" data-dir="">🏠 根目录</span>';
    var acc = '';
    parts.forEach(function (p, i) {
      acc += safeDecode(p) + '/';
      var last = i === parts.length - 1;
      html += '<span class="crumb-sep">/</span>' +
        '<span class="move-crumb-item ' + (last ? 'current' : '') + '" data-dir="' + escapeHtml(acc) + '">' +
        escapeHtml(safeDecode(p)) + '</span>';
    });
    crumb.innerHTML = html; // 点击走 bindBreadcrumbDelegate 的委托
    var same = moveState.target === currentDir;
    $('moveHint').textContent = '目标：' + (baseName(moveState.target) || '根目录') + (same ? '（与当前目录相同）' : '');
    $('moveGo').disabled = same;
  }

  function loadMoveFolders(prefix) {
    moveState.target = prefix || '';
    renderMoveCrumb();
    var box = $('moveFolders');
    box.innerHTML = '<div class="move-loading">加载中…</div>';
    // 翻页取全：子文件夹超过 1000 个时单次 list 会显示不全
    var folders = [];
    var reqPrefix = moveState.target;
    (async function () {
      try {
        var token = null;
        for (var guard = 0; guard < 100; guard++) {
          var page = await s3.list({ prefix: reqPrefix, maxKeys: 1000, token: token });
          for (var i = 0; i < (page.items || []).length; i++) {
            var f = page.items[i];
            if (!f.isFolder) continue;
            // 当前目录自己不显示：点进去目标与当前相同，「移到此处」永远禁用，像点了没反应
            if (currentDir && f.name === currentDir) continue;
            // 被移动的文件夹自身与其内部不能作为目标
            var blockedFolder = moveState.names.some(function (n) {
              return n.slice(-1) === '/' && (f.name === n || f.name.indexOf(n) === 0);
            });
            if (!blockedFolder) folders.push(f);
          }
          if (!page.truncated || !page.nextContinuationToken) break;
          token = page.nextContinuationToken;
        }
        if (moveState.target !== reqPrefix) return; // 用户已跳到别的层级：丢弃过期结果
        box.innerHTML = folders.length
          ? folders.map(function (f) {
              return '<div class="move-folder" data-dir="' + escapeHtml(f.name) + '">' +
                '<span class="mi">📁</span><span>' + escapeHtml(baseName(f.name)) + '</span></div>';
            }).join('')
          : '<div class="move-empty">（此层没有子文件夹，可直接点「移到此处」）</div>';
      // 点击走 bindBreadcrumbDelegate 的委托
      } catch (err) {
        box.innerHTML = '<div class="move-empty">读取文件夹失败：' + escapeHtml(err.message || err) + '</div>';
      }
    })();
  }

  // ---------- 重命名 / 新建文件夹 ----------
  function renameItem(name) {
    var isFolder = name.slice(-1) === '/';
    var label = isFolder ? '文件夹' : '文件';
    var input = prompt('重命名' + label + '（当前）：', baseName(name));
    if (input === null) return;
    var next = input.trim();
    if (!next) {
      toast('名称不能为空', 'err');
      return;
    }
    if (next === baseName(name)) return;
    var nameErr = entryNameError(next);
    if (nameErr) {
      toast(nameErr, 'err');
      return;
    }
    var dest = currentDir + (isFolder ? next + '/' : next);
    renameViaCopy(name, dest, isFolder);
  }

  async function renameViaCopy(src, dest, isFolder) {
    if (src === dest) return;
    if (opBusy) {
      toast('有操作正在进行中，请稍候', 'err');
      return;
    }
    opBusy = true;
    beginOp();
    try {
      if (isFolder) {
        // 文件夹重命名：复制整棵子树到新前缀，再删除旧前缀
        showProgress(null, '正在统计文件夹内容…', '');
        try {
          // 流式收集子树
          var allKeys = [];
          var objectKeys = [];
          await s3.listEach(src, function (items) {
            for (var i = 0; i < items.length; i++) {
              allKeys.push(items[i].name);
              if (!items[i].isFolder) objectKeys.push(items[i].name);
            }
          });
          var total = objectKeys.length + 1; // 末尾还需删除旧的文件夹标记
          var step = 0;
          // 并发复制（4 路）；失败时回滚已复制的目标 key（源目录不动）
          var copiedDest = [];
          try {
          await runPool(objectKeys, async function (k) {
            await s3.copy(k, dest + k.slice(src.length));
            copiedDest.push(dest + k.slice(src.length));
            step++;
            showProgress(step / total * 100, '正在移动 ' + baseName(k), step + ' / ' + total);
          }, 4);
          } catch (copyErr) {
            if (copiedDest.length) {
              try { await deleteKeys(copiedDest); } catch (e) { /* 回滚失败：保留现场供用户检查 */ }
            }
            throw copyErr;
          }
          // 删除旧前缀下的全部内容（含 0 字节的文件夹标记）；deleteKeys 内部并发删除。
          // 复制已成功、删除源失败 ≠ 重命名失败：目标完整，仅提示旧目录未清理
          var delFailed = null;
          try {
            await deleteKeys(allKeys);
          } catch (delErr) {
            delFailed = delErr;
          }
          step = total;
          showProgress(100, '完成', '');
          setTimeout(hideProgress, 500);
          if (delFailed) {
            toast('已复制为「' + baseName(dest) + '」，但删除旧文件夹失败：' + (delFailed.message || delFailed), 'err');
          } else {
            toast('文件夹已重命名为「' + baseName(dest) + '」', 'ok');
          }
          dirCacheInvalidate(currentDir);
          dirBitsInvalidate(currentDir);
          loadDir();
        } catch (err) {
          hideProgress();
          toast('重命名失败：' + err.message, 'err');
        }
        return;
      }
      try {
        await s3.copy(src, dest);
        await deleteKeys([src]);
        toast('已重命名', 'ok');
        dirCacheInvalidate(currentDir);
        dirBitsInvalidate(currentDir);
        loadDir();
      } catch (err) {
        toast('重命名失败：' + err.message, 'err');
      }
    } finally {
      opBusy = false;
      endOp();
    }
  }

  async function deleteKeys(names) {
    if (!names.length) return;
    for (var i = 0; i < names.length; i += 200) {
      await s3.remove(names.slice(i, i + 200));
    }
  }

  /** 条目名校验（新建/重命名共用）：不含 /、不是 . 或 ..（防止写到父目录等非预期前缀） */
  function entryNameError(next) {
    if (next.indexOf('/') !== -1) return '名称不能包含 /';
    if (next === '.' || next === '..') return '名称不能是 . 或 ..';
    return null;
  }

  function mkdir() {
    var input = prompt('新建文件夹名称：');
    if (input === null) return;
    var name = input.trim();
    if (!name) return;
    var err = entryNameError(name);
    if (err) {
      toast(err, 'err');
      return;
    }
    s3.mkdir(currentDir + name).then(function () {
      toast('文件夹已创建', 'ok');
      dirCacheInvalidate(currentDir);
      loadDir();
    }).catch(function (err) {
      toast('创建失败：' + err.message, 'err');
    });
  }

  // ---------- 搜索（桌面输入框 + 手机搜索行共用同一套过滤） ----------
  var searchTimer;
  function applySearch(v) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      searchText = v;
      scheduleRenderTable();
    }, 160);
  }
  $('searchInput').addEventListener('input', function (e) { applySearch(e.target.value.trim()); });
  $('mSearchInput').addEventListener('input', function (e) { applySearch(e.target.value.trim()); });
  $('mSearchBtn').addEventListener('click', function () {
    var row = $('mSearchRow');
    if (row.hidden) {
      row.hidden = false;
      $('mSearchInput').focus();
    } else {
      row.hidden = true;
      $('mSearchInput').value = '';
      applySearch('');
    }
  });
  $('mSearchCancel').addEventListener('click', function () {
    $('mSearchRow').hidden = true;
    $('mSearchInput').value = '';
    applySearch('');
  });

  // 点容量条手动重新全量扫描（本会话内唯一的刷新入口，无任何缓存判定）
  $('mCapStrip').addEventListener('click', function () {
    if (!s3 || !activeConfig) return;
    toast('正在重新统计容量…');
    scanUsage();
  });
  $('capWidget').addEventListener('click', function () {
    if (!s3 || !activeConfig) return;
    toast('正在重新统计容量…');
    scanUsage();
  });

  // ---------- 绑定 UI 事件 ----------
  bindTableDelegate();
  bindBreadcrumbDelegate();
  $('cfgForm').addEventListener('submit', saveConfig);
  $('btnTest').addEventListener('click', testConnection);
  $('btnExport').addEventListener('click', exportConfig);
  $('btnImport').addEventListener('click', importConfig);
  $('btnPasteImport').addEventListener('click', togglePasteImport);
  $('btnPasteGo').addEventListener('click', doPasteImport);
  $('btnPasteCancel').addEventListener('click', function () {
    $('pasteImport').hidden = true;
    $('pasteImportText').value = '';
  });
  $('btnEnvCheck').addEventListener('click', runEnvCheck);

  // 分区 Tab 切换
  Array.prototype.forEach.call(document.querySelectorAll('.section-tab'), function (tab) {
    tab.addEventListener('click', function () {
      activeSection = tab.getAttribute('data-section');
      Array.prototype.forEach.call(document.querySelectorAll('.section-tab'), function (t) {
        t.classList.toggle('active', t === tab);
      });
      selected.clear();
      updateSelBar();
      try {
        scheduleRenderTable();
      } catch (e) {
        // 渲染异常不阻断 Tab 切换（避免界面停在旧分区）
        console.error('renderTable error:', e);
        toast('分区渲染出错：' + e.message, 'err');
      }
    });
  });
  // 视图切换（网格/列表），按分区记忆
  $('btnViewGrid').addEventListener('click', function () {
    if (activeSection === 'all') return;
    setViewMode(activeSection, 'grid');
    scheduleRenderTable();
  });
  $('btnViewList').addEventListener('click', function () {
    if (activeSection === 'all') return;
    setViewMode(activeSection, 'list');
    scheduleRenderTable();
  });
  $('previewClose').addEventListener('click', closePreview);
  $('previewModal').addEventListener('click', function (e) {
    if (e.target === $('previewModal')) closePreview();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if ($('previewModal').style.display !== 'none') closePreview();
    else if ($('moveModal').style.display !== 'none') closeMovePicker();
    else if (!$('viewConfig').hidden && activeConfig) closeConfigView();
    else if ($('mSheet').style.display !== 'none') closeSheet();
  });

  // 手机底部操作栏
  $('mSheet').addEventListener('click', function (e) {
    if (e.target.closest('[data-sheet-close]')) { closeSheet(); return; }
    var b = e.target.closest('[data-idx]');
    if (!b || !sheetCtx) return;
    var action = sheetCtx[Number(b.getAttribute('data-idx'))];
    closeSheet();
    if (action && action.run) {
      // 延迟一拍执行：closeSheet 触发的 history.back() 是异步的，
      // 等 popstate 落定后再打开下一个浮层（如「移动到…」选择器），否则其 popstate 会误关新浮层
      setTimeout(function () { action.run(); }, 50);
    }
  });
  $('mBtnSelect').addEventListener('click', function () { setSelectMode(true); });
  $('mBtnCancel').addEventListener('click', function () { setSelectMode(false); });
  $('mBtnSelectAll').addEventListener('click', function () {
    var data = visibleItems();
    if (!data.length) return;
    var all = data.every(function (i) { return selected.has(i.name); });
    if (all) selected.clear();
    else data.forEach(function (i) { selected.add(i.name); });
    scheduleRenderTable();
  });
  $('mBtnDownload').addEventListener('click', downloadSelected);
  $('mBtnMove').addEventListener('click', function () {
    openMovePicker(Array.from(selected));
  });
  $('mBtnDelete').addEventListener('click', function () {
    deleteItems(Array.from(selected));
  });
  $('mBtnUpload').addEventListener('click', openUploadSheet);
  $('mBtnMkdir').addEventListener('click', mkdir);

  // 移动目标文件夹选择器
  $('btnMoveSel').addEventListener('click', function () {
    openMovePicker(Array.from(selected));
  });
  $('moveClose').addEventListener('click', closeMovePicker);
  $('moveCancel').addEventListener('click', closeMovePicker);
  $('moveGo').addEventListener('click', function () {
    var names = moveState.names.slice();
    var target = moveState.target;
    closeMovePicker();
    moveItems(names, target);
  });
  $('moveModal').addEventListener('click', function (e) {
    if (e.target === $('moveModal')) closeMovePicker();
  });
  $('btnClear').addEventListener('click', clearLocal);
  // 删除单条配置（区别于「清除本机配置」的全量清除）：仅删本机记录，不动 R2 文件
  $('btnDeleteCfg').addEventListener('click', function () {
    if (!activeConfig) return;
    var label = activeConfig.name || activeConfig.bucket;
    if (!confirm('确定删除配置「' + label + '」吗？\n只删除本机保存的这条配置，不会删除 R2 中的任何文件。')) return;
    cfg.remove(activeConfig.id);
    purgeLegacyUsageStorage(); // 兼容清除旧版本遗留的容量缓存
    resetUsage();
    dirCacheClear();
    dirBitsCache.clear(); // 被删配置的文件夹索引随之作废（applyConfig 会按新配置重建）
    renderConfigSelect();
    applyConfig(cfg.getActive());
    toast('已删除配置「' + label + '」', 'ok');
  });
  // ⚙ 设置作为开关：文件页时打开配置页，配置页时返回文件页
  $('btnSettings').addEventListener('click', function () {
    if (!$('viewConfig').hidden && activeConfig) closeConfigView();
    else showConfigView();
  });
  $('btnCfgBack').addEventListener('click', closeConfigView);
  $('btnNewConfig').addEventListener('click', showNewConfigView);
  $('btnRefresh').addEventListener('click', function () { loadDir({ bypass: true }); toast('已刷新', 'ok'); });
  $('btnMkdir').addEventListener('click', mkdir);
  $('btnDownloadSel').addEventListener('click', downloadSelected);
  $('btnCopyLinkSel').addEventListener('click', copySelectedLinks);
  $('btnDeleteSel').addEventListener('click', function () {
    deleteItems(Array.from(selected));
  });
  $('cfgSelect').addEventListener('change', function (e) {
    var list = cfg.loadAll();
    var next = list.filter(function (c) { return c.id === e.target.value; })[0];
    if (next) applyConfig(next);
  });

  // 设备形态变化（模拟器切换 / 折叠屏旋转）：切换布局并重渲染。
  // URL 强制指定 layout 时不自动切换。
  var resizeTimer;
  window.addEventListener('resize', function () {
    if (layoutForced !== null) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      var m = computeIsMobile();
      if (m === IS_MOBILE) return;
      IS_MOBILE = m;
      document.body.classList.toggle('mobile', m);
      document.body.classList.remove('select-mode');
      selectMode = false;
      selected.clear();
      closeSheet();
      updateSelBar();
      scheduleRenderTable();
    }, 250);
  });

  // ---------- 启动 ----------
  // CORS 配置提示里显示当前站点域名（浏览器访问本页的 origin，无尾部斜杠），
  // 用户可直接复制到 R2 桶的 AllowedOrigins
  var originEl = $('originHere');
  if (originEl) {
    try {
      originEl.textContent = location.origin;
      originEl.title = '这是浏览器访问本站点的来源域名，请原样复制到 R2 桶 CORS 的 AllowedOrigins（不要带尾部斜杠）';
    } catch (e) { /* ignore */ }
  }
  renderConfigSelect();
  purgeLegacyUsageStorage(); // 本版本不再使用容量缓存：启动即清掉旧键
  document.body.classList.toggle('mobile', IS_MOBILE);
  var saved = cfg.getActive();
  if (saved) {
    applyConfig(saved);
  } else {
    applyConfig(null);
    fillConfigForm(cfg.blank());
    $('viewConfig').hidden = false;
  }
})();
