// static/musicfree.js
(function() {
  'use strict';

  const { getAuthToken, apiGet, apiPost } = window.SongloftPlugin || {};
  function getHeaders() { return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getAuthToken() }; }

  let mfCmdConfigs = [];
  let mfPlugins = [];

  // ==========================================
  // 1. 初始化与插件拉取
  // ==========================================
  async function loadMfPlugins() {
    try {
      const res = await fetch('/api/v1/jsplugin/musicfree-adapter/plugins', { headers: getHeaders() });
      if (res.ok) {
        const data = await res.json();
        mfPlugins = Array.isArray(data) ? data : (Array.isArray(data.plugins) ? data.plugins : []);
        updatePlatformDropdowns();
        renderMfSources();
      }
    } catch (e) { console.warn("拉取 MusicFree 插件失败:", e); }
  }

  function updatePlatformDropdowns() {
    const modalSelect = document.getElementById('modal-mf-cmd-node');
    const defSelect = document.getElementById('mf-def-platform');
    if (!modalSelect || !defSelect) return;

    let modalHtml = '<option value="default">跟从全局默认配置</option>';
    let defHtml = '';

    mfPlugins.forEach(p => {
        if (p.enabled && p.platform) {
            const opt = `<option value="${p.platform}">${p.platform}</option>`;
            modalHtml += opt;
            defHtml += opt;
        }
    });

    const oldModalVal = modalSelect.value;

    // 🌟 核心修复 1：绝对不去读 UI 的旧值，只相信内存里真实的配置
    const realDefVal = mfGlobalSettings.settings.default_platform;

    modalSelect.innerHTML = modalHtml;
    defSelect.innerHTML = defHtml;

    if (oldModalVal) modalSelect.value = oldModalVal;

    // 🌟 核心修复 2：只做界面恢复，绝对不在这里触发保存！杜绝覆盖数据库！
    if (realDefVal && defSelect.querySelector(`option[value="${realDefVal}"]`)) {
        defSelect.value = realDefVal;
    }
  }

  // ==========================================
  // 全局默认偏好管理
  // ==========================================
  let mfGlobalSettings = { settings: { default_platform: '', default_quality: 'standard', default_strategy: 'first' } };

  async function loadMfGlobalSettings() {
      try {
          const res = await apiGet('/store?key=musicfree_config');
          if (res && res.data && res.data !== 'null') {
              mfGlobalSettings = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
          }
      } catch (e) {}

      const s = mfGlobalSettings.settings || {};
      const pEl = document.getElementById('mf-def-platform');
      const qEl = document.getElementById('mf-def-quality');
      const stEl = document.getElementById('mf-def-strategy');

      if (pEl) {
          if (s.default_platform && pEl.querySelector(`option[value="${s.default_platform}"]`)) {
              pEl.value = s.default_platform;
          } else if (pEl.options.length > 0) {
              // 🌟 核心修复 3：兜底和保存只能放在这！因为此时确信数据库已经被读取过了！
              pEl.value = pEl.options[0].value;
              saveMfGlobalSettings();
          }
      }
      if (qEl && s.default_quality) qEl.value = s.default_quality;
      if (stEl && s.default_strategy) stEl.value = s.default_strategy;
  }

  async function saveMfGlobalSettings() {
      const pEl = document.getElementById('mf-def-platform');
      const qEl = document.getElementById('mf-def-quality');
      const stEl = document.getElementById('mf-def-strategy');

      mfGlobalSettings.settings = {
          default_platform: pEl ? pEl.value : '',
          default_quality: qEl ? qEl.value : 'standard',
          default_strategy: stEl ? stEl.value : 'first'
      };

      try {
          await apiPost('/store', { key: 'musicfree_config', value: JSON.stringify(mfGlobalSettings) });
      } catch (e) {}
  }

  // ==========================================
  // 2. 口令配置管理
  // ==========================================
  async function loadMfCmds() {
    try {
      const res = await apiGet('/store?key=xiaoai_mf_configs');
      if (res && res.data && res.data !== 'null' && res.data !== '[]') {
          mfCmdConfigs = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
      }
      if (!Array.isArray(mfCmdConfigs) || mfCmdConfigs.length === 0) {
          mfCmdConfigs = [
              { engine: 'musicfree', type: 'search', node: 'default', quality: 'standard', strategy: 'first', limit: '', shuffle: false, isDefault: true, enabled: true, cmds: ['在线歌曲'] },
              { engine: 'musicfree', type: 'play', node: 'default', quality: 'standard', strategy: 'first', limit: '', shuffle: false, isDefault: true, enabled: true, cmds: ['在线歌单'] }
          ];
          await autoSaveMfCmds();
      }
      renderMfCmdContainers();
    } catch(e) {}
  }

  async function autoSaveMfCmds() {
    await apiPost('/store', { key: 'xiaoai_mf_configs', value: JSON.stringify(mfCmdConfigs) });
  }

  function renderMfCmdContainers() {
    const mainContainer = document.getElementById('mf-cmd-containers');
    if (!mainContainer) return;
    mainContainer.innerHTML = '';

    mfCmdConfigs.sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));

    mfCmdConfigs.forEach((cfg) => {
      const mapKey = `mf_${cfg.type}_${cfg.node}_${cfg.isDefault ? 'def' : 'cus'}`;
      const box = document.createElement('div');
      box.className = 'mh-field'; box.id = `cmd-box-${mapKey}`;

      // 🌟 1. 改为 [播放xxx]
      let typeDesc = cfg.type === 'search' ? '播放歌曲' : '播放歌单';

      let badgeHtml = '';
      if (!cfg.isDefault || cfg.limit || cfg.shuffle || (cfg.enableFixedKeyword && cfg.fixedKeyword)) {
          badgeHtml = `<div style="display: flex; gap: 4px; align-items: center; flex-wrap: wrap;">`;

          if (!cfg.isDefault) {
              badgeHtml += `<span style="border: 1px solid var(--md-outline-variant); padding: 2px 6px; border-radius: 4px; font-size: 11px; color: var(--md-on-surface-variant);">${cfg.node}</span>`;
          }

          if (!cfg.isDefault && cfg.quality) {
              let qText = cfg.quality;
              if (qText === 'high') qText = '无损';
              else if (qText === 'standard') qText = '高品质';
              else if (qText === 'low') qText = '标准';
              badgeHtml += `<span style="border: 1px solid var(--md-outline-variant); padding: 2px 6px; border-radius: 4px; font-size: 11px; color: var(--md-on-surface-variant);">${qText}</span>`;
          }

          // 🌟 2. 放宽策略胶囊条件：只要是歌单就显示！没有旧数据就兜底用 'first'
          if (!cfg.isDefault && cfg.type === 'play') {
              const stratMap = { first: '默认首个', random: '随机抽取', play_count: '热度优先', total: '数量优先' };
              const sText = stratMap[cfg.strategy || 'first'] || '默认首个';
              badgeHtml += `<span style="border: 1px solid var(--md-outline-variant); padding: 2px 6px; border-radius: 4px; font-size: 11px; color: var(--md-on-surface-variant);">${sText}</span>`;
          }

          if (cfg.limit) badgeHtml += `<span style="border: 1px solid var(--md-outline-variant); padding: 2px 6px; border-radius: 4px; font-size: 11px; color: var(--md-on-surface-variant);">限制: ${cfg.limit}首</span>`;
          if (cfg.shuffle) badgeHtml += `<span style="border: 1px solid var(--md-outline-variant); padding: 2px 6px; border-radius: 4px; font-size: 11px; color: var(--md-on-surface-variant);">乱序</span>`;
          if (cfg.enableFixedKeyword && cfg.fixedKeyword) {
              badgeHtml += `<span style="background: var(--md-primary); color: var(--md-on-primary); padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: bold;">固定词: ${cfg.fixedKeyword}</span>`;
          }

          badgeHtml += `</div>`;
      }

      let titleHtml = `<div style="display: flex; justify-content: flex-start; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap;">
        <label style="margin-bottom: 0; color: var(--md-on-surface); font-weight: bold;">[${typeDesc}] 口令组</label>
        ${badgeHtml}`;

      if (!cfg.isDefault) {
        titleHtml += `<button class="mh-btn" style="height: 24px; padding: 0 10px; font-size: 12px; border-color: var(--md-outline); color: var(--md-on-surface-variant);" onclick="window._editMfCmdGroup('${cfg.type}', '${cfg.node}', false)">✏️ 编辑</button>`;
      } else {
        titleHtml += `<span style="background: #e2e8f0; color: #475569; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: bold;">全局默认</span>`;
      }
      titleHtml += `</div>`;

      const isEnabled = cfg.enabled !== false;

      box.innerHTML = `
        ${titleHtml}
        <div style="display: flex; align-items: flex-start; gap: 12px; margin-bottom: 8px; justify-content: space-between;">
          <div id="tags-${mapKey}" class="mh-tag-container" style="flex: 1; margin-bottom: 0; transition: opacity 0.2s;"></div>
          <input type="checkbox" id="enable-${mapKey}" class="mh-switch-input" ${isEnabled ? 'checked' : ''} style="margin-top: 4px; flex-shrink: 0;" title="启用/停用此组">
        </div>
        <div id="input-area-${mapKey}" style="display: flex; gap: 12px; align-items: center; transition: opacity 0.2s;">
          <input type="text" id="input-${mapKey}" class="mh-input" placeholder="输入唤醒口令">
          <button class="mh-btn" id="btn-add-${mapKey}">➕ 口令</button>
        </div>
      `;
      mainContainer.appendChild(box);

      document.getElementById(`btn-add-${mapKey}`).addEventListener('click', () => addMfCmd(cfg.type, cfg.node, !!cfg.isDefault));
      document.getElementById(`input-${mapKey}`).addEventListener('keypress', (e) => { if (e.key === 'Enter') addMfCmd(cfg.type, cfg.node, !!cfg.isDefault); });

      const toggleEl = document.getElementById(`enable-${mapKey}`);
      const updateUiState = (enabled) => {
          const opacity = enabled ? '1' : '0.4';
          const ptrEvents = enabled ? 'auto' : 'none';
          document.getElementById(`tags-${mapKey}`).style.opacity = opacity;
          document.getElementById(`tags-${mapKey}`).style.pointerEvents = ptrEvents;
          document.getElementById(`input-area-${mapKey}`).style.opacity = opacity;
          document.getElementById(`input-area-${mapKey}`).style.pointerEvents = ptrEvents;
      };
      updateUiState(isEnabled);

      toggleEl?.addEventListener('change', async (e) => {
          cfg.enabled = e.target.checked;
          updateUiState(cfg.enabled);
          await autoSaveMfCmds();
      });

      renderMfTags(cfg.type, cfg.node, !!cfg.isDefault);
    });
  }

  function renderMfTags(type, node, isDefault) {
    const mapKey = `mf_${type}_${node}_${isDefault ? 'def' : 'cus'}`;
    const container = document.getElementById(`tags-${mapKey}`);
    if (!container) return;

    const cfg = mfCmdConfigs.find(c => c.type === type && c.node === node && !!c.isDefault === isDefault);
    const arr = (cfg && cfg.cmds) ? cfg.cmds : [];

    container.innerHTML = '';
    if (arr.length === 0) {
        container.innerHTML = `<span style="color: var(--md-error); font-size: 13px; font-weight: 500;">⚠️ 请增加口令</span>`;
        return;
    }

    arr.forEach((cmd, idx) => {
      const tag = document.createElement('div');
      tag.className = 'mh-tag';
      tag.innerHTML = `<span>${cmd}</span> <span class="mh-tag-close" title="移除">×</span>`;
      tag.querySelector('.mh-tag-close').addEventListener('click', () => {
        cfg.cmds.splice(idx, 1);
        renderMfTags(type, node, isDefault); autoSaveMfCmds();
      });
      container.appendChild(tag);
    });
  }

  function addMfCmd(type, node, isDefault) {
    const mapKey = `mf_${type}_${node}_${isDefault ? 'def' : 'cus'}`;
    const inputEl = document.getElementById(`input-${mapKey}`);
    const val = inputEl.value.trim();
    if (!val) return;

    const cfg = mfCmdConfigs.find(c => c.type === type && c.node === node && !!c.isDefault === isDefault);
    if (!cfg.cmds) cfg.cmds = [];
    if (cfg.cmds.includes(val)) return alert('⚠️ 该口令已存在');

    cfg.cmds.push(val);
    inputEl.value = '';
    renderMfTags(type, node, isDefault); autoSaveMfCmds();
  }

  let currentEditMode = null;
  const updateMfFixedKwUi = (enabled) => {
      const wrap = document.getElementById('modal-mf-cmd-fixed-wrap');
      if (wrap) {
          wrap.style.opacity = enabled ? '1' : '0.4';
          wrap.style.pointerEvents = enabled ? 'auto' : 'none';
      }
  };

  document.getElementById('modal-mf-cmd-enable-fixed')?.addEventListener('change', (e) => { updateMfFixedKwUi(e.target.checked); });

  document.getElementById('btn-show-add-mf-cmd')?.addEventListener('click', () => {
      currentEditMode = null;
      document.getElementById('mf-cmd-modal-title').innerText = '➕ 新增控制条目';
      document.getElementById('btn-mf-cmd-confirm').innerText = '✅ 创建';
      document.getElementById('btn-mf-cmd-delete').style.display = 'none';

      document.getElementById('modal-mf-cmd-type').value = 'search';
      document.getElementById('modal-mf-cmd-type').dispatchEvent(new Event('change'));
      document.getElementById('modal-mf-cmd-node').value = 'default';
      document.getElementById('modal-mf-cmd-quality').value = 'standard';
      document.getElementById('modal-mf-cmd-strategy').value = 'first';
      document.getElementById('modal-mf-cmd-limit').value = '';
      document.getElementById('modal-mf-cmd-shuffle').checked = false;

      document.getElementById('modal-mf-cmd-enable-fixed').checked = false;
      document.getElementById('modal-mf-cmd-fixed-kw').value = '';
      updateMfFixedKwUi(false);

      document.getElementById('mf-cmd-modal-mask').style.display = 'flex';
  });

  window._editMfCmdGroup = function(type, node, isDefault) {
      const cfg = mfCmdConfigs.find(c => c.type === type && c.node === node && !!c.isDefault === isDefault);
      if (!cfg) return;
      currentEditMode = { type, node, isDefault };

      document.getElementById('mf-cmd-modal-title').innerText = '✏️ 编辑控制条目';
      document.getElementById('btn-mf-cmd-confirm').innerText = '✅ 修改';
      document.getElementById('btn-mf-cmd-delete').style.display = 'inline-flex';

      document.getElementById('modal-mf-cmd-type').value = cfg.type || 'search';
      document.getElementById('modal-mf-cmd-type').dispatchEvent(new Event('change'));
      document.getElementById('modal-mf-cmd-node').value = cfg.node || 'default';
      document.getElementById('modal-mf-cmd-quality').value = cfg.quality || 'standard';
      document.getElementById('modal-mf-cmd-strategy').value = cfg.strategy || 'first';
      document.getElementById('modal-mf-cmd-limit').value = cfg.limit || '';
      document.getElementById('modal-mf-cmd-shuffle').checked = !!cfg.shuffle;

      const enableFixed = !!cfg.enableFixedKeyword;
      document.getElementById('modal-mf-cmd-enable-fixed').checked = enableFixed;
      document.getElementById('modal-mf-cmd-fixed-kw').value = cfg.fixedKeyword || '';
      updateMfFixedKwUi(enableFixed);

      document.getElementById('mf-cmd-modal-mask').style.display = 'flex';
  };

  const hideMfModal = () => { document.getElementById('mf-cmd-modal-mask').style.display = 'none'; };
  document.getElementById('btn-mf-cmd-cancel')?.addEventListener('click', hideMfModal);
  document.getElementById('mf-cmd-modal-mask')?.addEventListener('click', (e) => { if (e.target.id === 'mf-cmd-modal-mask') hideMfModal(); });

  document.getElementById('btn-mf-cmd-delete')?.addEventListener('click', async () => {
      if (!currentEditMode) return;
      if (!confirm('确定彻底删除该配置组吗？')) return;
      mfCmdConfigs = mfCmdConfigs.filter(c => !(c.type === currentEditMode.type && c.node === currentEditMode.node && !!c.isDefault === currentEditMode.isDefault));
      await autoSaveMfCmds(); hideMfModal(); renderMfCmdContainers();
  });

  document.getElementById('btn-mf-cmd-confirm')?.addEventListener('click', async () => {
      const type = document.getElementById('modal-mf-cmd-type').value;
      const node = document.getElementById('modal-mf-cmd-node').value;
      const quality = document.getElementById('modal-mf-cmd-quality').value;
      const strategy = document.getElementById('modal-mf-cmd-strategy').value;
      const limitStr = document.getElementById('modal-mf-cmd-limit').value;
      const limit = limitStr ? parseInt(limitStr, 10) : '';
      const shuffle = document.getElementById('modal-mf-cmd-shuffle').checked;

      const enableFixedKeyword = document.getElementById('modal-mf-cmd-enable-fixed').checked;
      const fixedKeyword = document.getElementById('modal-mf-cmd-fixed-kw').value.trim();

      if (currentEditMode) {
          if ((type !== currentEditMode.type || node !== currentEditMode.node) &&
              mfCmdConfigs.find(c => c.type === type && c.node === node && !!c.isDefault === currentEditMode.isDefault)) {
              return alert('⚠️ 该类型配置已存在，请换一个');
          }
          const cfg = mfCmdConfigs.find(c => c.type === currentEditMode.type && c.node === currentEditMode.node && !!c.isDefault === currentEditMode.isDefault);
          if (cfg) {
              cfg.type = type; cfg.node = node; cfg.quality = quality;
              cfg.strategy = strategy; cfg.limit = limit; cfg.shuffle = shuffle;
              cfg.enableFixedKeyword = enableFixedKeyword; cfg.fixedKeyword = fixedKeyword;
          }
      } else {
          if (mfCmdConfigs.find(c => c.type === type && c.node === node)) {
              return alert('⚠️ 该平台的类型已存在，请直接在列表中点“编辑”');
          }
          mfCmdConfigs.push({ engine: 'musicfree', type, node, quality, strategy, limit, shuffle, enableFixedKeyword, fixedKeyword, enabled: true, isDefault: false, cmds: [] });
      }

      await autoSaveMfCmds(); hideMfModal(); renderMfCmdContainers();
  });


  // ==========================================
  // 3. 源管理 (增删改查)
  // ==========================================

  window.deleteMfSource = async function(url) {
      if (!confirm('确定要删除这个源吗？')) return;
      try {
          const res = await fetch('/api/v1/jsplugin/musicfree-adapter/plugins', {
              method: 'DELETE',
              headers: getHeaders(),
              body: JSON.stringify({ url: url })
          });
          const data = await res.json();
          if (res.ok && data.success) {
              await loadMfPlugins();
              // 🌟 核心修复 4：源被删除后，重新执行一次校验兜底逻辑
              await loadMfGlobalSettings();
          } else {
              alert('删除失败: ' + (data.error || '未知错误'));
          }
      } catch (e) {
          alert('删除发生异常: ' + e.message);
      }
  };

  window.toggleMfSource = async function(url, enabled, checkboxEl) {
      checkboxEl.disabled = true;
      try {
          const res = await fetch('/api/v1/jsplugin/musicfree-adapter/plugins', {
              method: 'PUT',
              headers: getHeaders(),
              body: JSON.stringify({ url: url, enabled: enabled })
          });
          const data = await res.json();

          if (res.ok && data.success) {
              const p = mfPlugins.find(x => x.url === url);
              if (p) p.enabled = enabled;
              updatePlatformDropdowns();
              // 🌟 核心修复 5：源状态变化后，如果当前默认源被禁用了，也会触发降级兜底
              await loadMfGlobalSettings();
          } else {
              alert('状态切换失败: ' + (data.error || '未知错误'));
              checkboxEl.checked = !enabled;
          }
      } catch (e) {
          alert('网络异常: ' + e.message);
          checkboxEl.checked = !enabled;
      } finally {
          checkboxEl.disabled = false;
      }
  };

  async function importMfSourceUrl() {
      const url = prompt('请输入 MusicFree 插件的 URL 地址 (如 https://.../*.js)\n支持原版插件与第三方兼容源：');
      if (!url) return;

      const btn = document.getElementById('btn-mf-import-url');
      const originalText = btn.innerText;
      btn.innerText = '⏳ 导入中...';
      btn.style.pointerEvents = 'none';

      try {
          const res = await fetch('/api/v1/jsplugin/musicfree-adapter/plugins', {
              method: 'POST',
              headers: getHeaders(),
              body: JSON.stringify({ url: url, force: false })
          });
          const data = await res.json();

          if (res.ok && data.success) {
              alert(`🎉 导入成功！\n平台：${data.platform || '未知'}\n版本：${data.version || '未知'}`);
              await loadMfPlugins();
          } else {
              alert('导入失败: ' + (data.error || '可能是链接不可用或文件格式错误'));
          }
      } catch (e) {
          alert('网络异常: ' + e.message);
      } finally {
          btn.innerText = originalText;
          btn.style.pointerEvents = 'auto';
      }
  }

  async function importMfSourceFile(file) {
      const btn = document.getElementById('btn-mf-import');
      const originalText = btn.innerText;
      btn.innerText = '⏳ 解析并上传...';
      btn.style.pointerEvents = 'none';

      try {
          const text = await file.text();
          const res = await fetch('/api/v1/jsplugin/musicfree-adapter/plugins', {
              method: 'POST',
              headers: getHeaders(),
              body: JSON.stringify({ code: text, force: false })
          });
          const data = await res.json();

          if (res.ok && data.success) {
              alert(`🎉 本地源解析导入成功！\n平台：${data.platform || '未知'}\n版本：${data.version || '未知'}`);
              await loadMfPlugins();
          } else {
              alert('上传失败: ' + (data.error || '非法的插件代码结构'));
          }
      } catch (e) {
          alert('文件读取或上传异常: ' + e.message);
      } finally {
          btn.innerText = originalText;
          btn.style.pointerEvents = 'auto';
      }
  }

  function renderMfSources() {
      const listEl = document.getElementById('mf-sources-list');
      if (!listEl) return;
      if (mfPlugins.length === 0) {
          listEl.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--md-on-surface-variant); font-size: 13px;">暂未安装任何源</div>';
          return;
      }

      let html = '';
      mfPlugins.forEach(p => {
          const identifyUrl = p.url || '';

          html += `
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--md-outline-variant);">
              <div style="flex: 1; min-width: 0;">
                  <div style="font-weight: bold; font-size: 14px; margin-bottom: 4px;">${p.platform || '未知源'} <span style="font-size: 11px; font-weight: normal; color: var(--md-on-surface-variant); margin-left: 6px;">v${p.version || '0.0'}</span></div>
                  <div style="font-size: 11px; color: var(--md-on-surface-variant); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${p.srcUrl || p.url || ''}</div>
              </div>
              <div style="display: flex; align-items: center; gap: 8px; flex-shrink: 0;">
                  <input type="checkbox" class="mh-switch-input" ${p.enabled ? 'checked' : ''} onchange="window.toggleMfSource('${identifyUrl}', this.checked, this)">
                  <button class="mh-source-del-btn" onclick="window.deleteMfSource('${identifyUrl}')">🗑️</button>
              </div>
          </div>`;
      });
      listEl.innerHTML = html;
  }

  document.addEventListener('DOMContentLoaded', async () => {
      await loadMfPlugins();
      await loadMfGlobalSettings();
      loadMfCmds();

      // 监听功能类型的切换，动态显示/隐藏策略下拉框
      const mfModalType = document.getElementById('modal-mf-cmd-type');
      const mfStratField = document.getElementById('mf-strategy-field');

      mfModalType?.addEventListener('change', (e) => {
          if (e.target.value === 'play') {
              mfStratField.style.display = 'block';
          } else {
              mfStratField.style.display = 'none';
          }
      });

      ['mf-def-platform', 'mf-def-quality', 'mf-def-strategy'].forEach(id => {
          document.getElementById(id)?.addEventListener('change', saveMfGlobalSettings);
      });
      document.getElementById('btn-mf-import-url')?.addEventListener('click', importMfSourceUrl);

      document.getElementById('btn-mf-import')?.addEventListener('click', () => {
          const fileInput = document.getElementById('mf-file-input');
          if (fileInput) fileInput.click();
      });

      document.getElementById('mf-file-input')?.addEventListener('change', (e) => {
          const file = e.target.files[0];
          if (file) {
              importMfSourceFile(file);
              e.target.value = '';
          }
      });

      document.getElementById('btn-mf-subscribe')?.addEventListener('click', () => alert('订阅源功能对接中...'));
  });
})();