// static/webdav.js
(function() {
  'use strict';

  const { getAuthToken, apiGet, apiPost } = window.SongloftPlugin || {};
  let currentDavServers = [];
  let defaultServerName = '';
  let currentBrowserPath = '/';

  // ==========================================
  // 模块 A：WebDAV 口令管理 (全聚合 JSON 极简版)
  // ==========================================
  let cmdConfigs = [];

  function loadVoiceCmds() {
    try {
      const cached = localStorage.getItem('iweb_wd_configs_cache');
      if (cached) { cmdConfigs = JSON.parse(cached); renderAllCmdContainers(); }
    } catch(e) {}

    apiGet('/store?key=xiaoai_dav_configs').then(async listRes => {
      if (listRes && listRes.data) {
        try {
          const savedConfigs = typeof listRes.data === 'string' ? JSON.parse(listRes.data) : listRes.data;
          if (Array.isArray(savedConfigs) && savedConfigs.length > 0) {
            cmdConfigs = savedConfigs;
            localStorage.setItem('iweb_wd_configs_cache', JSON.stringify(cmdConfigs));
          }
        } catch(e) {}
      }

      // 容错兜底注入
      if (cmdConfigs.length === 0) {
          cmdConfigs = [
              { type: 'play', node: 'default', label: '播放 WebDAV 歌单口令(默认节点)', isDefault: true, cmds: ['网盘歌单'] },
              { type: 'search', node: 'default', label: '播放 WebDAV 歌曲口令(默认节点)', isDefault: true, cmds: ['网盘歌曲'] }
          ];
          await autoSaveVoiceCmds();
      }
      renderAllCmdContainers();
    }).catch(e => console.warn("加载口令失败:", e));
  }

  function renderAllCmdContainers() {
    const mainContainer = document.getElementById('voice-cmd-containers');
    if (!mainContainer) return;
    mainContainer.innerHTML = '';

    cmdConfigs.forEach((cfg) => {
      const mapKey = `${cfg.type}_${cfg.node}`;
      const isDefault = cfg.node === 'default';
      const containerId = `cmd-box-${mapKey}`;

      const box = document.createElement('div');
      box.className = 'mh-field'; box.id = containerId;

      let badgeHtml = '';
      if (!isDefault && (cfg.limit || cfg.shuffle || (cfg.enableFixedKeyword && cfg.fixedKeyword))) {
          badgeHtml = `<div style="display: flex; gap: 4px; align-items: center;">`;
          if (cfg.limit) badgeHtml += `<span style="border: 1px solid var(--md-outline-variant); padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: normal; color: var(--md-on-surface-variant);">限制: ${cfg.limit}首</span>`;
          if (cfg.shuffle) badgeHtml += `<span style="border: 1px solid var(--md-outline-variant); padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: normal; color: var(--md-on-surface-variant);">乱序: 开启</span>`;
          if (cfg.enableFixedKeyword && cfg.fixedKeyword) {
              badgeHtml += `<span style="background: var(--md-primary); color: var(--md-on-primary); padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: bold;">固定词: ${cfg.fixedKeyword}</span>`;
          }
          badgeHtml += `</div>`;
      }

      let titleHtml = `<div style="display: flex; justify-content: flex-start; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap;">
        <label style="margin-bottom: 0; color: var(--md-on-surface); font-weight: bold;">${cfg.label}</label>
        ${badgeHtml}`;

      if (!isDefault) {
        titleHtml += `<button class="mh-btn" style="height: 24px; padding: 0 10px; font-size: 12px; border-color: var(--md-outline); color: var(--md-on-surface-variant);" onclick="window._editCmdGroup('${cfg.type}', '${cfg.node}')">✏️ 编辑</button>`;
      }
      titleHtml += `</div>`;

      const placeholderText = cfg.type === 'play' ? '输入口令，如：网盘歌单' : '输入口令，如：网盘歌曲';
      const isEnabled = cfg.enabled !== false; // 默认启用

      box.innerHTML = `
        ${titleHtml}
        <div style="display: flex; align-items: flex-start; gap: 12px; margin-bottom: 8px; justify-content: space-between;">
          <div id="tags-${mapKey}" class="mh-tag-container" style="flex: 1; margin-bottom: 0; transition: opacity 0.2s;"></div>
          <input type="checkbox" id="enable-${mapKey}" class="mh-switch-input" ${isEnabled ? 'checked' : ''} style="margin-top: 4px; flex-shrink: 0;" title="启用/停用此组">
        </div>
        <div id="input-area-${mapKey}" style="display: flex; gap: 12px; align-items: center; transition: opacity 0.2s;">
          <input type="text" id="input-${mapKey}" class="mh-input" placeholder="${placeholderText}">
          <button class="mh-btn" id="btn-add-${mapKey}">➕ 口令</button>
        </div>
      `;

      mainContainer.appendChild(box);

      document.getElementById(`btn-add-${mapKey}`).addEventListener('click', () => addVoiceCmd(cfg.type, cfg.node));
      document.getElementById(`input-${mapKey}`).addEventListener('keypress', (e) => {
        if (e.key === 'Enter') addVoiceCmd(cfg.type, cfg.node);
      });

      const toggleEl = document.getElementById(`enable-${mapKey}`);
      const tagsEl = document.getElementById(`tags-${mapKey}`);
      const inputArea = document.getElementById(`input-area-${mapKey}`);

      const updateUiState = (enabled) => {
          const opacity = enabled ? '1' : '0.4';
          const ptrEvents = enabled ? 'auto' : 'none';
          if (tagsEl) { tagsEl.style.opacity = opacity; tagsEl.style.pointerEvents = ptrEvents; }
          if (inputArea) { inputArea.style.opacity = opacity; inputArea.style.pointerEvents = ptrEvents; }
      };

      updateUiState(cfg.enabled !== false);

      toggleEl?.addEventListener('change', async (e) => {
          cfg.enabled = e.target.checked;
          updateUiState(cfg.enabled);
          await autoSaveVoiceCmds();
      });

      renderTags(cfg.type, cfg.node);
    });
  }

  function renderTags(type, node) {
    const mapKey = `${type}_${node}`;
    const container = document.getElementById(`tags-${mapKey}`);
    if (!container) return;

    const cfg = cmdConfigs.find(c => c.type === type && c.node === node);
    const arr = (cfg && cfg.cmds) ? cfg.cmds : [];

    container.innerHTML = '';
    if (arr.length === 0) {
        container.innerHTML = `<span style="color: var(--md-error); font-size: 13px; display: inline-flex; align-items: center; height: 28px; font-weight: 500;">⚠️ 请增加口令</span>`;
        return;
    }

    arr.forEach((cmd, idx) => {
      const tag = document.createElement('div');
      tag.className = 'mh-tag';
      tag.innerHTML = `<span>${cmd}</span> <span class="mh-tag-close" title="移除">×</span>`;
      tag.querySelector('.mh-tag-close').addEventListener('click', () => {
        cfg.cmds.splice(idx, 1);
        renderTags(type, node); autoSaveVoiceCmds();
      });
      container.appendChild(tag);
    });
  }

  async function autoSaveVoiceCmds() {
    await apiPost('/store', { key: 'xiaoai_dav_configs', value: JSON.stringify(cmdConfigs) });
    localStorage.setItem('iweb_wd_configs_cache', JSON.stringify(cmdConfigs));
  }

  function addVoiceCmd(type, node) {
    const mapKey = `${type}_${node}`;
    const inputEl = document.getElementById(`input-${mapKey}`);
    const val = inputEl.value.trim();
    if (!val) return;

    const cfg = cmdConfigs.find(c => c.type === type && c.node === node);
    if (!cfg) return;

    if (!cfg.cmds) cfg.cmds = [];
    if (cfg.cmds.includes(val)) return alert('⚠️ 该口令已存在');

    cfg.cmds.push(val);
    inputEl.value = '';
    renderTags(type, node); autoSaveVoiceCmds();
  }

  // ========== UI 弹窗状态机与控制 ==========
  function getHeaders() { return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getAuthToken() }; }

  let currentWdEditMode = null;

  function showCmdModal(editMode = null) {
    const mask = document.getElementById('cmd-modal-mask');
    const nodeSelect = document.getElementById('modal-cmd-node');
    if (!mask || !nodeSelect) return;

    nodeSelect.innerHTML = '';
    if (currentDavServers.length === 0) {
      nodeSelect.innerHTML = '<option value="">暂无可关联节点，请先添加</option>';
    } else {
      currentDavServers.forEach(srv => {
        const opt = document.createElement('option');
        opt.value = srv.name;
        opt.innerText = srv.name + (srv.name === defaultServerName ? ' (默认)' : '');
        nodeSelect.appendChild(opt);
      });
    }

    currentWdEditMode = editMode;

    const limitEl = document.getElementById('modal-cmd-limit');
    const shuffleEl = document.getElementById('modal-cmd-shuffle');
    const enableFixedEl = document.getElementById('modal-cmd-enable-fixed');
    const fixedKwEl = document.getElementById('modal-cmd-fixed-kw');
    const fixedWrap = document.getElementById('modal-cmd-fixed-wrap');

    const updateWdFixedUi = (enabled) => {
        if (fixedWrap) {
            fixedWrap.style.opacity = enabled ? '1' : '0.4';
            fixedWrap.style.pointerEvents = enabled ? 'auto' : 'none';
        }
    };
    if (enableFixedEl) enableFixedEl.onchange = (e) => updateWdFixedUi(e.target.checked);

    if (editMode) {
        document.getElementById('cmd-modal-title').innerText = '✏️ 编辑控制条目';
        document.getElementById('btn-cmd-confirm').innerText = '✅ 修改';
        document.getElementById('btn-cmd-delete').style.display = 'inline-flex';

        document.getElementById('modal-cmd-type').value = editMode.type;
        document.getElementById('modal-cmd-node').value = editMode.node;

        if (limitEl) limitEl.value = editMode.limit || '';
        if (shuffleEl) shuffleEl.checked = !!editMode.shuffle;

        if (enableFixedEl) enableFixedEl.checked = !!editMode.enableFixedKeyword;
        if (fixedKwEl) fixedKwEl.value = editMode.fixedKeyword || '';
        updateWdFixedUi(!!editMode.enableFixedKeyword);
    } else {
        document.getElementById('cmd-modal-title').innerText = '➕ 新增控制条目';
        document.getElementById('btn-cmd-confirm').innerText = '✅ 创建';
        document.getElementById('btn-cmd-delete').style.display = 'none';

        document.getElementById('modal-cmd-type').value = 'play';

        if (limitEl) limitEl.value = '';
        if (shuffleEl) shuffleEl.checked = false;

        if (enableFixedEl) enableFixedEl.checked = false;
        if (fixedKwEl) fixedKwEl.value = '';
        updateWdFixedUi(false);
    }

    mask.style.display = 'flex';
  }

  function hideCmdModal() {
    const mask = document.getElementById('cmd-modal-mask');
    if (mask) mask.style.display = 'none';
  }

  window._editCmdGroup = function(type, node) {
      const cfg = cmdConfigs.find(c => c.type === type && c.node === node);
      if (!cfg) return;
      showCmdModal(cfg);
  };

  async function handleConfirmCmd() {
    const type = document.getElementById('modal-cmd-type').value;
    const node = document.getElementById('modal-cmd-node').value;
    if (!node) return alert('请先选择有效的 WebDAV 节点');

    const limitStr = document.getElementById('modal-cmd-limit').value;
    const limit = limitStr ? parseInt(limitStr, 10) : '';
    const shuffle = document.getElementById('modal-cmd-shuffle').checked;

    const enableFixedKeyword = document.getElementById('modal-cmd-enable-fixed').checked;
    const fixedKeyword = document.getElementById('modal-cmd-fixed-kw').value.trim();

    if (currentWdEditMode) {
        const cfg = cmdConfigs.find(c => c.type === currentWdEditMode.type && c.node === currentWdEditMode.node);
        if (cfg) {
            cfg.type = type; cfg.node = node;
            cfg.label = type === 'play' ? `播放 WebDAV 歌单口令(${node})` : `播放 WebDAV 歌曲口令(${node})`;
            cfg.limit = limit; cfg.shuffle = shuffle;
            cfg.enableFixedKeyword = enableFixedKeyword;
            cfg.fixedKeyword = fixedKeyword;
        }
    } else {
        const typeText = type === 'play' ? '播放 WebDAV 歌单口令' : '播放 WebDAV 歌曲口令';
        cmdConfigs.push({ type, node, label: `${typeText}(${node})`, enabled: true, isDefault: false, cmds: [], limit, shuffle, enableFixedKeyword, fixedKeyword });
    }

    await autoSaveVoiceCmds();
    hideCmdModal(); renderAllCmdContainers();
  }

  async function handleDeleteCmd() {
      if (!currentWdEditMode) return;
      if (!confirm('确定彻底删除该口令配置组吗？')) return;

      cmdConfigs = cmdConfigs.filter(c => !(c.type === currentWdEditMode.type && c.node === currentWdEditMode.node));
      await autoSaveVoiceCmds();
      hideCmdModal();
      renderAllCmdContainers();
  }

  // ========== 其余 WebDAV 逻辑 ==========

  async function getWebDavConfig() {
      const res = await apiGet('/store?key=webdav_config');
      if (res && res.data && res.data !== 'null' && res.data !== '[]') {
          try { return JSON.parse(res.data); } catch(e) {}
      }
      return { settings: { mode: 'proxy', default_server: '' }, roots: {}, search_history: [] };
  }

  async function saveWebDavConfig(cfg) {
      await apiPost('/store', { key: 'webdav_config', value: JSON.stringify(cfg) });
  }

  async function loadDavServers() {
    try {
      const res = await fetch('/api/v1/jsplugin/dav/lists', { headers: getHeaders() });

      if (res.status === 403) {
          const json = await res.json().catch(() => ({}));
          if (json.detail === 'plugin_disabled') {
              if (window.showPluginDisabledMask) window.showPluginDisabledMask('tab-webdav', json.error);
              return;
          }
      }

      if (!res.ok) throw new Error("未启用 dav 插件");
      currentDavServers = await res.json() || [];

      const cfg = await getWebDavConfig();
      defaultServerName = cfg.settings.default_server || '';

      const masterSelect = document.getElementById('dav-master-select');
      const configSelect = document.getElementById('dav-server-select');

      masterSelect.innerHTML = currentDavServers.length ? '' : '<option value="">暂无节点</option>';
      configSelect.innerHTML = currentDavServers.length ? '' : '<option value="">暂无节点，请添加</option>';

      currentDavServers.forEach(srv => {
        const opt1 = document.createElement('option'); opt1.value = srv.name; opt1.innerText = srv.name + (srv.name === defaultServerName ? ' (默认)' : ''); masterSelect.appendChild(opt1);
        const opt2 = document.createElement('option'); opt2.value = srv.name; opt2.innerText = srv.name + (srv.name === defaultServerName ? ' (默认)' : ''); configSelect.appendChild(opt2);
      });

      if (defaultServerName && currentDavServers.find(s => s.name === defaultServerName)) {
        masterSelect.value = defaultServerName; configSelect.value = defaultServerName;
      }
      onMasterSelect(); onConfigSelect();
    } catch (e) { console.warn("拉取节点失败:", e); }
  }

  async function onMasterSelect() {
    const val = document.getElementById('dav-master-select').value;
    if (!val) return;
    const cfg = await getWebDavConfig();
    document.getElementById('auto-scan-select').value = cfg.settings[`auto_scan_interval_${val}`] || '0';
    loadScanStats(val);
  }

  async function loadScanStats(davId) {
    const textEl = document.getElementById('scan-stats-text');
    if (!davId) { textEl.innerHTML = '暂无节点'; return; }
    try {
      const res = await apiGet(`/store?key=${encodeURIComponent('webdav_lib_' + davId)}`);
      if (res && res.data && res.data !== 'null') {
          const stats = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
          textEl.innerHTML = `包含 <b>${stats.folders || 0}</b> 个歌单，共 <b>${stats.songs || 0}</b> 首歌曲 <span style="opacity:0.7; margin-left:8px;">(上次扫描: ${stats.time || '未知'})</span>`;
      } else {
          textEl.innerHTML = `尚未建立索引，请点击下方建立`;
      }
    } catch(e) { textEl.innerHTML = `暂无索引数据`; }
  }

  async function onAutoScanChange() {
    const val = document.getElementById('dav-master-select').value;
    const hours = document.getElementById('auto-scan-select').value;
    if (!val) return;
    const cfg = await getWebDavConfig();
    cfg.settings[`auto_scan_interval_${val}`] = hours;
    await saveWebDavConfig(cfg);
  }

  async function triggerScan(eventOrDavId) {
    const isAuto = typeof eventOrDavId === 'string';
    const davId = isAuto ? eventOrDavId : document.getElementById('dav-master-select').value;

    if (!davId) return alert('请先选择一个节点');

    if (isAuto) {
        const masterSelect = document.getElementById('dav-master-select');
        if (masterSelect.value !== davId) {
            masterSelect.value = davId;
            onMasterSelect();
        }
    }

    const cfg = await getWebDavConfig();
    const rootPath = (cfg.roots && cfg.roots[davId]) ? cfg.roots[davId] : '/';

    document.getElementById('scan-status').innerText = '⏳ 正在向后台发送扫库指令...';
    await apiPost('/dav/scan', { davId, rootPath }); pollScanStatus();
  }

  function pollScanStatus() {
    apiGet('/dav/status').then(res => {
      const textEl = document.getElementById('scan-status');
      const davId = document.getElementById('dav-master-select').value;
      if (res.status === 'scanning') { textEl.innerText = `⏳ 正在全量扫描网盘... 已发现 ${res.scanned_folders} 个带音乐的文件夹，请耐心等待`; setTimeout(pollScanStatus, 3000); }
      else if (res.status === 'completed') { textEl.innerText = `✅ 扫库完成！数据已落盘并成功广播。`; loadScanStats(davId); }
      else textEl.innerText = `❌ 扫库任务异常或中止`;
    });
  }

  async function onConfigSelect() {
    const val = document.getElementById('dav-server-select').value;
    const btnDel = document.getElementById('btn-delete');
    const btnDef = document.getElementById('btn-set-default');

    if (!val) { btnDel.style.display = 'none'; return; }
    btnDel.style.display = 'inline-flex';
    if (val === defaultServerName) { btnDef.style.opacity = '0.5'; btnDef.title = "已是默认节点"; } else { btnDef.style.opacity = '1'; btnDef.title = "将此节点设为默认"; }

    const cfg = await getWebDavConfig();
    document.getElementById('dav-root-path').value = (cfg.roots && cfg.roots[val]) ? cfg.roots[val] : '/';
    document.getElementById('dav-dir-browser').style.display = 'none';
  }

  async function renderDirBrowser(path) {
    const curSrv = document.getElementById('dav-server-select').value;
    if (!curSrv) return alert("请先选择活跃网盘");

    const listEl = document.getElementById('wd-dir-list');
    const breadEl = document.getElementById('wd-dir-breadcrumbs');
    listEl.innerHTML = '<li style="padding: 10px; text-align: center; color: var(--md-on-surface-variant);">正在拉取目录树...</li>';

    if (path === '/') breadEl.innerHTML = `<span style="cursor:pointer; color: var(--md-primary); font-weight: 500;" onclick="window._navigateDav('/')">🏠 根目录</span>`;
    else {
      let parts = path.split('/').filter(Boolean);
      let breadHtml = `<span style="cursor:pointer; color: var(--md-primary); font-weight: 500;" onclick="window._navigateDav('/')">🏠 根目录</span>`;
      let buildPath = '';
      parts.forEach((p) => { buildPath += '/' + p; breadHtml += `<span style="color: var(--md-on-surface-variant); margin: 0 4px;">/</span><span style="cursor:pointer; color: var(--md-primary); font-weight: 500;" onclick="window._navigateDav('${buildPath}')">${p}</span>`; });
      breadEl.innerHTML = breadHtml;
    }

    try {
      const res = await fetch(`/api/v1/jsplugin/dav/lists/${encodeURIComponent(curSrv)}/items?path=${encodeURIComponent(path)}`, { headers: getHeaders() });
      const items = await res.json();
      listEl.innerHTML = '';
      const dirs = items.filter(i => i.type === 'directory');

      if (dirs.length === 0) listEl.innerHTML = '<li style="padding: 14px; text-align: center; color: var(--md-on-surface-variant); font-size: 13px;">该目录下无子文件夹</li>';
      else {
        dirs.forEach(d => {
          const li = document.createElement('li');
          li.style.cssText = 'padding: 12px 14px; border-bottom: 1px solid var(--md-outline-variant); font-size: 14px; color: var(--md-on-surface); cursor: pointer; display: flex; align-items: center; gap: 10px; transition: background 0.2s;';
          li.onmouseover = () => li.style.background = 'var(--md-surface-variant)';
          li.onmouseout = () => li.style.background = 'transparent';
          li.innerHTML = `📁 <span style="flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${d.name}</span>`;
          li.addEventListener('click', () => {
            const nextPath = path === '/' ? '/' + d.name : path + '/' + d.name;
            currentBrowserPath = nextPath; renderDirBrowser(nextPath);
          });
          listEl.appendChild(li);
        });
      }

      setTimeout(() => {
          window.scrollTo({
              top: document.body.scrollHeight + 50,
              behavior: 'smooth'
          });
      }, 50);

    } catch (e) { listEl.innerHTML = `<li style="padding: 20px; text-align: center; color: var(--md-error); font-size: 13px;">目录加载失败，请检查网络或节点配置</li>`; }
  }

  window._navigateDav = function(targetPath) { currentBrowserPath = targetPath; renderDirBrowser(targetPath); };

  function toggleForm(show) {
    document.getElementById('dav-edit-form').style.display = show ? 'block' : 'none';
    if (show) { ['dav-name', 'dav-url', 'dav-user', 'dav-pass'].forEach(id => document.getElementById(id).value = ''); }
  }

  async function saveServer() {
    const payload = {
      name: document.getElementById('dav-name').value.trim(), url: document.getElementById('dav-url').value.trim(),
      username: document.getElementById('dav-user').value.trim(), password: document.getElementById('dav-pass').value.trim()
    };
    if (!payload.name || !payload.url) return alert('别名和 URL 必填');
    await fetch('/api/v1/jsplugin/dav/lists', { method: 'POST', headers: getHeaders(), body: JSON.stringify(payload) });

    toggleForm(false);
    await loadDavServers();
    triggerScan(payload.name);
  }
  async function deleteServer() {
    const val = document.getElementById('dav-server-select').value;
    if (!val || !confirm(`确定删除 [${val}] 吗？`)) return;
    await fetch(`/api/v1/jsplugin/dav/lists/${encodeURIComponent(val)}`, { method: 'DELETE', headers: getHeaders() });

    const cfg = await getWebDavConfig();
    let changed = false;
    if (cfg.settings.default_server === val) { cfg.settings.default_server = ''; changed = true; }
    if (cfg.roots && cfg.roots[val]) { delete cfg.roots[val]; changed = true; }
    if (cfg.settings[`auto_scan_interval_${val}`]) { delete cfg.settings[`auto_scan_interval_${val}`]; changed = true; }

    if (changed) await saveWebDavConfig(cfg);

    alert('✅ 节点已删除'); loadDavServers();
  }

  async function testServer() {
    const payload = {
      name: 'test_temp', url: document.getElementById('dav-url').value.trim(),
      username: document.getElementById('dav-user').value.trim(), password: document.getElementById('dav-pass').value.trim()
    };
    try {
      await fetch('/api/v1/jsplugin/dav/lists', { method: 'POST', headers: getHeaders(), body: JSON.stringify(payload) });
      const res = await fetch(`/api/v1/jsplugin/dav/lists/test_temp/items?path=/`, { headers: getHeaders() });
      if (res.ok) alert("✅ 测试成功，连通正常！"); else alert("❌ 握手失败");
      await fetch(`/api/v1/jsplugin/dav/lists/test_temp`, { method: 'DELETE', headers: getHeaders() });
    } catch (e) { alert("❌ 网络异常"); }
  }

  async function setDefaultServer() {
    const val = document.getElementById('dav-server-select').value;
    if (!val) return;

    const cfg = await getWebDavConfig();
    cfg.settings.default_server = val;
    await saveWebDavConfig(cfg);
    loadDavServers();
  }

  document.addEventListener('DOMContentLoaded', async () => {
    document.getElementById('btn-show-add-cmd').addEventListener('click', () => showCmdModal(null));
    document.getElementById('btn-cmd-cancel').addEventListener('click', hideCmdModal);
    document.getElementById('btn-cmd-confirm').addEventListener('click', handleConfirmCmd);
    document.getElementById('btn-cmd-delete').addEventListener('click', handleDeleteCmd);

    const mask = document.getElementById('cmd-modal-mask');
    if (mask) mask.addEventListener('click', (e) => { if (e.target === mask) hideCmdModal(); });

    document.getElementById('dav-master-select').addEventListener('change', onMasterSelect);
    document.getElementById('dav-server-select').addEventListener('change', onConfigSelect);
    document.getElementById('auto-scan-select').addEventListener('change', onAutoScanChange);
    document.getElementById('btn-trigger-scan').addEventListener('click', triggerScan);

    document.getElementById('btn-show-add').addEventListener('click', () => toggleForm(true));
    document.getElementById('btn-cancel').addEventListener('click', () => toggleForm(false));
    document.getElementById('btn-save').addEventListener('click', saveServer);
    document.getElementById('btn-test').addEventListener('click', testServer);
    document.getElementById('btn-delete').addEventListener('click', deleteServer);
    document.getElementById('btn-set-default').addEventListener('click', setDefaultServer);

    document.getElementById('btn-browse-dir').addEventListener('click', () => {
      const browserBox = document.getElementById('dav-dir-browser');
      browserBox.style.display = 'block';
      currentBrowserPath = document.getElementById('dav-root-path').value;
      renderDirBrowser(currentBrowserPath);

      setTimeout(() => {
          browserBox.scrollIntoView({ behavior: 'smooth', block: 'end' });
      }, 100);
    });
    document.getElementById('btn-dir-cancel').addEventListener('click', () => { document.getElementById('dav-dir-browser').style.display = 'none'; });

    document.getElementById('btn-dir-confirm').addEventListener('click', async () => {
      document.getElementById('dav-root-path').value = currentBrowserPath;
      document.getElementById('dav-dir-browser').style.display = 'none';
      const val = document.getElementById('dav-server-select').value;

      if (val) {
        const cfg = await getWebDavConfig();
        if (!cfg.roots) cfg.roots = {};

        const oldPath = cfg.roots[val] || '/';

        if (oldPath !== currentBrowserPath) {
            cfg.roots[val] = currentBrowserPath;
            await saveWebDavConfig(cfg);
            triggerScan(val);
        } else {
            alert(`✅ 根目录未改变，无需重新扫描`);
        }
      }
    });

    loadVoiceCmds();
    loadDavServers();
  });

})();