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

      // 🌟 定义 5 大默认指令 (保留原有，补充新增)
      const defaultLx = [
          { engine: 'lxmusic', type: 'play', node: 'default', quality: '320k', strategy: 'first', isDefault: true, cmds: ['搜索歌单'] },
          { engine: 'lxmusic', type: 'search', node: 'default', quality: '320k', strategy: 'first', isDefault: true, cmds: ['搜索歌曲'] },
          { engine: 'lxmusic', type: 'singer', node: 'default', quality: '320k', strategy: 'first', isDefault: true, cmds: ['搜索歌手'] },
          { engine: 'lxmusic', type: 'album', node: 'default', quality: '320k', strategy: 'first', isDefault: true, cmds: ['搜索专辑'] },
          { engine: 'lxmusic', type: 'rank', node: 'default', quality: '320k', strategy: 'first', isDefault: true, cmds: ['搜索榜单'] }

      ];

      // 🌟 首次安装 或 升级查漏补缺
      if (lxCmdConfigs.length === 0) {
          lxCmdConfigs = [...defaultLx];
          await autoSaveLxCmds();
      } else {
          let added = false;
          // 遍历 5 个默认指令，如果当前用户的配置里缺了某个类型，就自动补进去
          defaultLx.forEach(d => {
              if (!lxCmdConfigs.find(c => c.isDefault && c.type === d.type && c.engine === d.engine)) {
                  lxCmdConfigs.push(d);
                  added = true;
              }
          });
          if (added) await autoSaveLxCmds();
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
      // 🌟 修改：精准映射所有类型
      const typeNameMap = { play: '歌单', search: '歌曲', singer: '歌手', album: '专辑', rank: '榜单' };
      const typeName = typeNameMap[cfg.type] || '歌曲';

      let labelText = ''; let badgeHtml = '';

      if (cfg.isDefault) {
          labelText = `搜索 LXMusic ${typeName}口令(默认配置)`;
      } else {
          const platName = platMap[cfg.node] || cfg.node;
          labelText = `搜${platName}${typeName}`; // 去掉了 [定制]

          badgeHtml = `<div style="display: flex; gap: 4px; align-items: center;">`;
          badgeHtml += `<span style="border: 1px solid var(--md-outline-variant); padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: normal; color: var(--md-on-surface-variant);">音质: ${cfg.quality || '320k'}</span>`;
          if (cfg.type === 'play') badgeHtml += `<span style="border: 1px solid var(--md-outline-variant); padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: normal; color: var(--md-on-surface-variant);">策略: ${stratMap[cfg.strategy] || '默认'}</span>`;
          if (cfg.limit) badgeHtml += `<span style="border: 1px solid var(--md-outline-variant); padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: normal; color: var(--md-on-surface-variant);">限制: ${cfg.limit}首</span>`;
          if (cfg.shuffle) badgeHtml += `<span style="border: 1px solid var(--md-outline-variant); padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: normal; color: var(--md-on-surface-variant);">乱序: 开启</span>`;
          badgeHtml += `</div>`;
      }

      let titleHtml = `<div style="display: flex; justify-content: flex-start; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap;">
        <label style="margin-bottom: 0; color: var(--md-on-surface); font-weight: bold;">${labelText}</label>
        ${badgeHtml}`;

      if (!cfg.isDefault) {
          titleHtml += `<button class="mh-btn" style="height: 24px; padding: 0 10px; font-size: 12px; border-color: var(--md-outline); color: var(--md-on-surface-variant);" onclick="window._editLxCmdGroup('${cfg.type}', '${cfg.node}')">✏️ 编辑</button>`;
      }
      titleHtml += `</div>`;

      const isEnabled = cfg.enabled !== false;

      box.innerHTML = `
        ${titleHtml}
        <!-- 👇 将口令胶囊容器和开关放在同一个 flex 行内，开关居右 -->
        <div style="display: flex; align-items: flex-start; gap: 12px; margin-bottom: 8px; justify-content: space-between;">
          <div id="lx-tags-${mapKey}" class="mh-tag-container" style="flex: 1; margin-bottom: 0; transition: opacity 0.2s;"></div>
          <input type="checkbox" id="lx-enable-${mapKey}" class="mh-switch-input" ${isEnabled ? 'checked' : ''} style="margin-top: 2px; flex-shrink: 0;" title="启用/停用此组">
        </div>
        <!-- 👇 输入框和添加按钮单独在下面一行 -->
        <div id="lx-input-area-${mapKey}" style="display: flex; gap: 12px; align-items: center; transition: opacity 0.2s;">
          <input type="text" id="lx-input-${mapKey}" class="mh-input" placeholder="输入口令，如：全网${typeName}">
          <button class="mh-btn" id="lx-btn-add-${mapKey}">➕ 口令</button>
        </div>
      `;

      mainContainer.appendChild(box);
      document.getElementById(`lx-btn-add-${mapKey}`).addEventListener('click', () => addLxCmd(cfg.type, cfg.node));
      document.getElementById(`lx-input-${mapKey}`).addEventListener('keypress', (e) => { if (e.key === 'Enter') addLxCmd(cfg.type, cfg.node); });

      // 获取当前项的开关、标签容器和输入框区域
      const toggleEl = document.getElementById(`lx-enable-${mapKey}`);
      const tagsEl = document.getElementById(`lx-tags-${mapKey}`);
      const inputArea = document.getElementById(`lx-input-area-${mapKey}`);

      const updateUiState = (enabled) => {
          const opacity = enabled ? '1' : '0.4';
          const ptrEvents = enabled ? 'auto' : 'none';
          // 开关已经在外面了，现在可以直接让整个胶囊区和输入区变灰禁用
          if (tagsEl) { tagsEl.style.opacity = opacity; tagsEl.style.pointerEvents = ptrEvents; }
          if (inputArea) { inputArea.style.opacity = opacity; inputArea.style.pointerEvents = ptrEvents; }
      };

      // 初始渲染时置灰
      updateUiState(cfg.enabled !== false);

      toggleEl?.addEventListener('change', async (e) => {
          cfg.enabled = e.target.checked;
          updateUiState(cfg.enabled);
          await autoSaveLxCmds();
      });

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
    // 统一的口令为空提示
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

      // 🌟 拦截 LXMusic 页的 403 报错
      if (res.status === 403) {
          const json = await res.json().catch(() => ({}));
          if (json.detail === 'plugin_disabled') {
              if (window.showPluginDisabledMask) window.showPluginDisabledMask('tab-lxmusic', json.error);
              return;
          }
      }

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
            <button class="mh-source-del-btn btn-delete-lx-source" data-id="${src.id}" title="删除此源">
              <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="pointer-events: none;">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                <line x1="10" y1="11" x2="10" y2="17"></line>
                <line x1="14" y1="11" x2="14" y2="17"></line>
              </svg>
            </button>
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
      const importUrlBtn = document.getElementById('btn-lx-import-url'); // 🌟 新增的 URL 导入按钮

      // 1. 本地文件上传
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
              finally { importBtn.innerText = "➕ 上传.js源脚本"; importBtn.style.pointerEvents = "auto"; fileInput.value = ""; }
          });
      }

      // 2. 从 URL 网址导入源脚本 (直传后端新接口)
      if (importUrlBtn) {
          importUrlBtn.addEventListener('click', async () => {
              const inputUrl = prompt("请输入 .js 源脚本的完整 URL 地址：");
              if (!inputUrl || !inputUrl.trim()) return;

              const targetUrl = inputUrl.trim();
              importUrlBtn.innerText = "⏳ 正在导入..."; importUrlBtn.style.pointerEvents = "none";

              try {
                  // 直接调用你提供的后端专用 import-url 接口
                  const res = await fetch('/api/v1/jsplugin/lxmusic/api/sources/import-url', {
                      method: 'POST',
                      headers: getJsonHeaders(),
                      body: JSON.stringify({ url: targetUrl })
                  });

                  if (res && res.ok) {
                      const data = await res.json();
                      if (data.code === 0) {
                          alert(`✅ URL 脚本 [${data.data?.name || '未知'}] 导入成功！`);
                          loadLxSources(); // 刷新列表
                      } else {
                          alert(`❌ 导入失败: ${data.msg || '未知错误'}`);
                      }
                  } else {
                      alert("❌ 导入失败，请检查 URL 地址是否有效或查看后端日志");
                  }
              } catch(err) {
                  alert("❌ 导入过程发生网络异常: " + err.message);
              } finally {
                  // 恢复按钮状态
                  importUrlBtn.innerText = "➕ 从URL导入源";
                  importUrlBtn.style.pointerEvents = "auto";
              }
          });
      }
      loadLxSources();

      const modalType = document.getElementById('modal-lx-cmd-type');
      const stratField = document.getElementById('lx-strategy-field');

      modalType?.addEventListener('change', (e) => {
          if (e.target.value === 'play') {
              stratField.style.display = 'block';
          } else {
              stratField.style.display = 'none';
          }
      });

      let currentEditMode = null;

      // 1. 点击“新增控制条目”时：进入【新增模式】
      document.getElementById('btn-show-add-lx-cmd')?.addEventListener('click', () => {
          currentEditMode = null;
          // UI 初始化
          document.getElementById('lx-cmd-modal-title').innerText = '➕ 新增控制条目';
          document.getElementById('btn-lx-cmd-confirm').innerText = '✅ 创建';
          document.getElementById('btn-lx-cmd-delete').style.display = 'none'; // 隐藏删除按钮

          const limitEl = document.getElementById('modal-lx-cmd-limit');
          if (limitEl) limitEl.value = '';
          const shuffleEl = document.getElementById('modal-lx-cmd-shuffle');
          if (shuffleEl) shuffleEl.checked = false;

          document.getElementById('modal-lx-cmd-type').value = 'play';
          document.getElementById('modal-lx-cmd-node').value = 'wy';
          document.getElementById('modal-lx-cmd-quality').value = '320k';
          document.getElementById('modal-lx-cmd-strategy').value = 'first';
          document.getElementById('modal-lx-cmd-type').dispatchEvent(new Event('change'));

          const mask = document.getElementById('lx-cmd-modal-mask');
          if (mask) mask.style.display = 'flex';
      });

      // 2. 点击列表里的“编辑”时：进入【编辑模式】并回显数据
      window._editLxCmdGroup = function(type, node) {
          const cfg = lxCmdConfigs.find(c => c.type === type && c.node === node);
          if (!cfg) return;
          currentEditMode = { type, node }; // 记录靶向靶标

          // UI 初始化
          document.getElementById('lx-cmd-modal-title').innerText = '✏️ 编辑控制条目';
          document.getElementById('btn-lx-cmd-confirm').innerText = '✅ 修改';
          document.getElementById('btn-lx-cmd-delete').style.display = 'inline-flex'; // 显示删除按钮

          // 核心：回显数据到表单
          document.getElementById('modal-lx-cmd-type').value = cfg.type || 'play';
          document.getElementById('modal-lx-cmd-node').value = cfg.node || 'wy';
          document.getElementById('modal-lx-cmd-quality').value = cfg.quality || '320k';
          document.getElementById('modal-lx-cmd-strategy').value = cfg.strategy || 'first';
          document.getElementById('modal-lx-cmd-limit').value = cfg.limit || '';
          document.getElementById('modal-lx-cmd-shuffle').checked = !!cfg.shuffle;

          // 触发一次 change 事件以联动显示/隐藏策略框
          document.getElementById('modal-lx-cmd-type').dispatchEvent(new Event('change'));

          const mask = document.getElementById('lx-cmd-modal-mask');
          if (mask) mask.style.display = 'flex';
      };

      // 3. 弹窗关闭与取消
      const hideModal = () => { document.getElementById('lx-cmd-modal-mask').style.display = 'none'; };
      document.getElementById('btn-lx-cmd-cancel')?.addEventListener('click', hideModal);
      document.getElementById('lx-cmd-modal-mask')?.addEventListener('click', (e) => { if (e.target.id === 'lx-cmd-modal-mask') hideModal(); });

      // 4. 处理弹窗内的【删除】
      document.getElementById('btn-lx-cmd-delete')?.addEventListener('click', async () => {
          if (!currentEditMode) return;
          if (!confirm('确定彻底删除该配置组吗？（包含其中的所有口令词将一并清除）')) return;

          lxCmdConfigs = lxCmdConfigs.filter(c => !(c.type === currentEditMode.type && c.node === currentEditMode.node));
          await autoSaveLxCmds();
          hideModal();
          renderLxCmdContainers();
      });

      // 5. 处理弹窗内的【确认】（根据状态自动分流：新增 or 更新）
      document.getElementById('btn-lx-cmd-confirm')?.addEventListener('click', async () => {
        const type = document.getElementById('modal-lx-cmd-type').value;
        const node = document.getElementById('modal-lx-cmd-node').value;
        const quality = document.getElementById('modal-lx-cmd-quality').value;
        const strategy = document.getElementById('modal-lx-cmd-strategy').value;

        const limitStr = document.getElementById('modal-lx-cmd-limit').value;
        const limit = limitStr ? parseInt(limitStr, 10) : '';
        const shuffle = document.getElementById('modal-lx-cmd-shuffle').checked;

        if (currentEditMode) {
            // == 编辑模式 ==
            // 拦截：如果用户把平台或类型改成了另一个已经存在的项（防冲突）
            if ((type !== currentEditMode.type || node !== currentEditMode.node) &&
                lxCmdConfigs.find(c => c.type === type && c.node === node && !c.isDefault)) {
                return alert('⚠️ 目标平台的该类型配置已存在，无法修改为该类型，请换一个');
            }

            // 找到原靶标进行数据覆盖更新
            const cfg = lxCmdConfigs.find(c => c.type === currentEditMode.type && c.node === currentEditMode.node);
            if (cfg) {
                cfg.type = type; cfg.node = node; cfg.quality = quality;
                cfg.strategy = strategy; cfg.limit = limit; cfg.shuffle = shuffle;
            }
        } else {
            // == 新增模式 ==
            if (lxCmdConfigs.find(c => c.type === type && c.node === node && !c.isDefault)) {
                return alert('⚠️ 该平台的类型已存在，请直接在列表中点“编辑”修改');
            }
            lxCmdConfigs.push({ engine: 'lxmusic', type, node, quality, strategy, limit, shuffle, enabled: true, isDefault: false, cmds: [] });
        }

        await autoSaveLxCmds();
        hideModal(); renderLxCmdContainers();
      });
  });
})();