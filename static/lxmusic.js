// static/lxmusic.js
(function() {
  'use strict';

  const { getAuthToken, apiGet, apiPost } = window.SongloftPlugin || {};

  function getHeaders() { return { 'Authorization': 'Bearer ' + getAuthToken() }; }
  function getJsonHeaders() { return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getAuthToken() }; }

  // ==========================================
  // 模块 A：LXMusic 口令管理 (全聚合 JSON 极简版)
  // ==========================================
  let lxCmdConfigs = [];

  function loadLxVoiceCmds() {
    try {
      const cached = localStorage.getItem('iweb_lx_configs_cache');
      if (cached) { lxCmdConfigs = JSON.parse(cached); renderLxCmdContainers(); }
    } catch(e) {}

    apiGet('/store?key=xiaoai_lx_configs').then(async listRes => {
      if (listRes && listRes.data) {
        try {
          const savedConfigs = typeof listRes.data === 'string' ? JSON.parse(listRes.data) : listRes.data;
          if (Array.isArray(savedConfigs) && savedConfigs.length > 0) {
              lxCmdConfigs = savedConfigs;
              localStorage.setItem('iweb_lx_configs_cache', JSON.stringify(lxCmdConfigs));
          }
        } catch(e) {}
      }

      // 如果全网第一次运行（后端的注入可能比前端慢了几毫秒），前端也做一次主动回退保护
      if (lxCmdConfigs.length === 0) {
          lxCmdConfigs = [
              { engine: 'lxmusic', type: 'play', node: 'default', quality: '320k', strategy: 'first', isDefault: true, cmds: ['搜索歌单'] },
              { engine: 'lxmusic', type: 'search', node: 'default', quality: '320k', strategy: 'first', isDefault: true, cmds: ['搜索歌曲'] }
          ];
          await autoSaveLxCmds();
      }
      renderLxCmdContainers();
    }).catch(e => console.warn("加载 LXMusic 口令失败:", e));
  }

  function renderLxCmdContainers() {
    const mainContainer = document.getElementById('lx-cmd-containers');
    if (!mainContainer) return;
    mainContainer.innerHTML = '';

    lxCmdConfigs.forEach((cfg) => {
      const mapKey = `${cfg.type}_${cfg.node}`;
      const box = document.createElement('div');
      box.className = 'mh-field'; box.id = `lx-cmd-box-${mapKey}`;

      const platMap = { wy: '网易云音乐', tx: 'QQ音乐', kg: '酷狗音乐', kw: '酷我音乐', mg: '咪咕音乐' };
      const stratMap = { first: '默认首个', random: '随机挑选', play_count: '热度优先', total: '数量优先' };
      const typeName = cfg.type === 'play' ? '歌单' : '歌曲';

      let labelText = ''; let badgeHtml = '';

      if (cfg.isDefault) {
          labelText = `搜索 LXMusic ${typeName}口令(默认配置)`;
      } else {
          const platName = platMap[cfg.node] || cfg.node;
          labelText = `[定制] 搜${platName}${typeName}`;
          badgeHtml = `<span style="border: 1px solid var(--md-outline-variant); padding: 2px 6px; border-radius: 4px; font-size: 11px; margin-left: 6px; font-weight: normal; color: var(--md-on-surface-variant);">音质: ${cfg.quality || '320k'}</span>`;
          if (cfg.type === 'play') badgeHtml += `<span style="border: 1px solid var(--md-outline-variant); padding: 2px 6px; border-radius: 4px; font-size: 11px; margin-left: 6px; font-weight: normal; color: var(--md-on-surface-variant);">策略: ${stratMap[cfg.strategy] || '默认'}</span>`;
      }

      let titleHtml = `<div style="display: flex; justify-content: flex-start; align-items: center; gap: 12px; margin-bottom: 6px; flex-wrap: wrap;">
        <label style="margin-bottom: 0; color: var(--md-on-surface); font-weight: bold;">${labelText}</label>
        ${badgeHtml}`;

      if (!cfg.isDefault) {
          titleHtml += `<button class="mh-btn mh-btn-danger" style="height: 24px; padding: 0 8px; font-size: 12px;" onclick="window._deleteLxCmdGroup('${cfg.type}', '${cfg.node}')">🗑️ 删除此组</button>`;
      }
      titleHtml += `</div>`;

      box.innerHTML = `
        ${titleHtml}
        <div id="lx-tags-${mapKey}" class="mh-tag-container"></div>
        <div style="display: flex; gap: 12px; align-items: center;">
          <input type="text" id="lx-input-${mapKey}" class="mh-input" placeholder="输入口令，如：全网${typeName}">
          <button class="mh-btn" id="lx-btn-add-${mapKey}">➕ 添加</button>
        </div>
      `;

      mainContainer.appendChild(box);
      document.getElementById(`lx-btn-add-${mapKey}`).addEventListener('click', () => addLxCmd(cfg.type, cfg.node));
      document.getElementById(`lx-input-${mapKey}`).addEventListener('keypress', (e) => { if (e.key === 'Enter') addLxCmd(cfg.type, cfg.node); });

      renderLxTags(cfg.type, cfg.node);
    });
  }

  function renderLxTags(type, node) {
    const mapKey = `${type}_${node}`;
    const container = document.getElementById(`lx-tags-${mapKey}`);
    if (!container) return;

    const cfg = lxCmdConfigs.find(c => c.type === type && c.node === node);
    const arr = (cfg && cfg.cmds) ? cfg.cmds : [];

    container.innerHTML = '';
    arr.forEach((cmd, idx) => {
      const tag = document.createElement('div');
      tag.className = 'mh-tag';
      tag.innerHTML = `<span>${cmd}</span> <span class="mh-tag-close" title="移除">×</span>`;
      tag.querySelector('.mh-tag-close').addEventListener('click', () => {
        cfg.cmds.splice(idx, 1);
        renderLxTags(type, node); autoSaveLxCmds();
      });
      container.appendChild(tag);
    });
  }

  async function autoSaveLxCmds() {
    await apiPost('/store', { key: 'xiaoai_lx_configs', value: JSON.stringify(lxCmdConfigs) });
    localStorage.setItem('iweb_lx_configs_cache', JSON.stringify(lxCmdConfigs));
  }

  function addLxCmd(type, node) {
    const mapKey = `${type}_${node}`;
    const inputEl = document.getElementById(`lx-input-${mapKey}`);
    const val = inputEl.value.trim();
    if (!val) return;

    const cfg = lxCmdConfigs.find(c => c.type === type && c.node === node);
    if (!cfg) return;

    if (!cfg.cmds) cfg.cmds = [];
    if (cfg.cmds.includes(val)) return alert('⚠️ 该口令已存在');

    cfg.cmds.push(val);
    inputEl.value = '';
    renderLxTags(type, node); autoSaveLxCmds();
  }

  window._deleteLxCmdGroup = async function(type, node) {
    if (!confirm(`确定删除该配置组吗？（删除后该配置下的口令也将一并清除）`)) return;
    lxCmdConfigs = lxCmdConfigs.filter(c => !(c.type === type && c.node === node));
    await autoSaveLxCmds();
    renderLxCmdContainers();
  };

  // ==========================================
  // 模块 B：全局默认偏好管理 (统一 lxmusic_config)
  // ==========================================

  // 🌟 LXMusic 聚合配置读取助手
  async function getLxMusicConfig() {
      const res = await apiGet('/store?key=lxmusic_config');
      if (res && res.data && res.data !== 'null' && res.data !== '[]') {
          try { return JSON.parse(res.data); } catch(e) {}
      }
      return { settings: { default_platform: 'wy', default_quality: '320k', default_strategy: 'first' } };
  }

  // 🌟 LXMusic 聚合配置保存助手
  async function saveLxMusicConfig(cfg) {
      await apiPost('/store', { key: 'lxmusic_config', value: JSON.stringify(cfg) });
  }

  async function initGlobalPreferences() {
      const pPlatform = document.getElementById('lx-def-platform');
      const pQuality = document.getElementById('lx-def-quality');
      const pStrategy = document.getElementById('lx-def-strategy');
      if (!pPlatform || !pQuality || !pStrategy) return;

      // 1. 初始化时拉取一次聚合配置并渲染
      const cfg = await getLxMusicConfig();
      if (!cfg.settings) cfg.settings = {};

      pPlatform.value = cfg.settings.default_platform || 'wy';
      pQuality.value = cfg.settings.default_quality || '320k';
      pStrategy.value = cfg.settings.default_strategy || 'first';

      // 2. 任何下拉框改动，都更新聚合配置并保存
      const updateAndSave = async () => {
          const currentCfg = await getLxMusicConfig();
          if (!currentCfg.settings) currentCfg.settings = {};

          currentCfg.settings.default_platform = pPlatform.value;
          currentCfg.settings.default_quality = pQuality.value;
          currentCfg.settings.default_strategy = pStrategy.value;

          await saveLxMusicConfig(currentCfg);
      };

      pPlatform.addEventListener('change', updateAndSave);
      pQuality.addEventListener('change', updateAndSave);
      pStrategy.addEventListener('change', updateAndSave);
  }

  // ==========================================
  // 模块 C：LXMusic 源管理
  // ==========================================
  async function loadLxSources() {
    const listEl = document.getElementById('lx-sources-list');
    if (!listEl) return;

    try {
      const res = await fetch('/api/v1/jsplugin/lxmusic/api/sources', { headers: getJsonHeaders() });
      if (!res.ok) { listEl.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--md-error); font-size: 13px;">⚠️ 无法连接到 LXMusic 插件。</div>'; return; }

      const responseJson = await res.json();
      const sources = responseJson?.data?.list || [];

      if (sources.length === 0) { listEl.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--md-on-surface-variant); font-size: 13px;">暂未导入任何源脚本。</div>'; return; }

      const platMap = { wy: '网易云', tx: 'QQ音乐', kg: '酷狗', kw: '酷我', mg: '咪咕' };

      listEl.innerHTML = sources.map(src => {
        const platformsStr = (src.platforms || []).map(p => platMap[p] || p).join('、');
        const descText = platformsStr ? `支持平台: ${platformsStr}` : '无平台信息';

        return `
        <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px; border-bottom: 1px solid var(--md-outline-variant);">
          <div style="flex: 1; min-width: 0; padding-right: 10px;">
            <div style="font-size: 14px; font-weight: bold; margin-bottom: 4px; color: var(--md-on-surface);">${src.name} <span style="font-weight:normal; color:var(--md-primary); font-size:12px; margin-left:4px;">${src.version || ''}</span></div>
            <div style="font-size: 12px; color: var(--md-on-surface-variant); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${descText}</div>
          </div>
          <div style="display: flex; gap: 12px; align-items: center;">
            <label class="lx-switch">
              <input type="checkbox" class="lx-toggle-source" data-id="${src.id}" ${src.enabled ? 'checked' : ''}>
              <span class="lx-slider"></span>
            </label>
            <button class="mh-source-del-btn" data-id="${src.id}" style="height: 24px; padding: 0 8px; font-size: 12px; border:none; background:transparent;">🗑️</button>
          </div>
        </div>
        `;
      }).join('');

      document.querySelectorAll('.lx-toggle-source').forEach(el => {
          el.addEventListener('change', async (e) => {
              const id = e.target.dataset.id; const enabled = e.target.checked;
              try { await fetch('/api/v1/jsplugin/lxmusic/api/sources/toggle', { method: 'PUT', headers: getJsonHeaders(), body: JSON.stringify({ id, enabled }) }); }
              catch(err) { alert("切换状态失败"); loadLxSources(); }
          });
      });

      document.querySelectorAll('.btn-delete-lx-source').forEach(el => {
          el.addEventListener('click', async (e) => {
              if (!confirm('确定彻底删除该源脚本吗？')) return;
              try { await fetch(`/api/v1/jsplugin/lxmusic/api/sources?id=${encodeURIComponent(e.target.dataset.id)}`, { method: 'DELETE', headers: getJsonHeaders() }); loadLxSources(); }
              catch(err) { alert("删除失败"); }
          });
      });

    } catch (e) { listEl.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--md-error); font-size: 13px;">网络异常。</div>'; }
  }

  document.addEventListener('DOMContentLoaded', () => {
      initGlobalPreferences();
      loadLxVoiceCmds();

      const fileInput = document.getElementById('lx-file-input');
      const importBtn = document.getElementById('btn-lx-import');

      if (importBtn && fileInput) {
          importBtn.addEventListener('click', () => fileInput.click());

          fileInput.addEventListener('change', async (e) => {
              const file = e.target.files[0];
              if (!file) return;

              const formData = new FormData();
              formData.append('file', file);
              importBtn.innerText = "⏳ 正在上传..."; importBtn.style.pointerEvents = "none";

              try {
                  const res = await fetch('/api/v1/jsplugin/lxmusic/api/sources/import', { method: 'POST', headers: getHeaders(), body: formData });
                  if (res.ok) { alert("✅ 脚本导入成功！"); loadLxSources(); } else alert("❌ 导入失败，请检查格式");
              } catch(err) { alert("❌ 上传发生异常"); }
              finally { importBtn.innerText = "➕ 导入.js源"; importBtn.style.pointerEvents = "auto"; fileInput.value = ""; }
          });
      }
      loadLxSources();

      const modalType = document.getElementById('modal-lx-cmd-type');
      const stratField = document.getElementById('lx-strategy-field');

      modalType?.addEventListener('change', (e) => {
          if (e.target.value === 'search') stratField.style.display = 'none';
          else stratField.style.display = 'block';
      });

      document.getElementById('btn-show-add-lx-cmd')?.addEventListener('click', () => {
          const mask = document.getElementById('lx-cmd-modal-mask');
          if (mask) mask.style.display = 'flex';
      });

      const hideModal = () => { document.getElementById('lx-cmd-modal-mask').style.display = 'none'; };
      document.getElementById('btn-lx-cmd-cancel')?.addEventListener('click', hideModal);
      document.getElementById('lx-cmd-modal-mask')?.addEventListener('click', (e) => { if (e.target.id === 'lx-cmd-modal-mask') hideModal(); });

      document.getElementById('btn-lx-cmd-confirm')?.addEventListener('click', async () => {
        const type = document.getElementById('modal-lx-cmd-type').value;
        const node = document.getElementById('modal-lx-cmd-node').value;
        const quality = document.getElementById('modal-lx-cmd-quality').value;
        const strategy = document.getElementById('modal-lx-cmd-strategy').value;

        if (lxCmdConfigs.find(c => c.type === type && c.node === node && !c.isDefault)) {
            return alert('⚠️ 该平台的类型已存在，请直接在下方添加口令');
        }

        lxCmdConfigs.push({ engine: 'lxmusic', type, node, quality, strategy, isDefault: false, cmds: [] });
        await autoSaveLxCmds();
        hideModal(); renderLxCmdContainers();
      });
  });
})();