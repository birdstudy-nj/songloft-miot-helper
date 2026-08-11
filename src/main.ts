/// <reference types="@songloft/plugin-sdk" />
import { jsonResponse, createRouter, parseQuery } from '@songloft/plugin-sdk';
import type { HTTPRequest, HTTPResponse } from '@songloft/plugin-sdk';
import { setupWebDAVRoutes, searchWebDavSongs } from './webdav';
import { handleLxMusicCommand } from './lxmusic';

const router = createRouter();
let wsClient: any = null;
const TWIN_PLUGIN_ID = 'iwebplayer';

// ==========================================
// 🚀 全局内存缓存 (零延迟读取)
// ==========================================
let cachedServerHost: string = '';

let cachedGlobalSettings: { targetPlaylist?: string; hitSound?: string } = {
    targetPlaylist: 'iWebPlayer推送',
    hitSound: 'SongLoft_for_u.a2ac34c5.mp3'
};

// ⏱️ 提示音定时器句柄映射表 (${accountId}_${deviceId})
const hitSoundTimers = new Map<string, any>();
const failedSoundTimers = new Map<string, any>();

// 取消指定设备的所有运行定时器
function cancelAllTimers(accountId: string, deviceId: string) {
    const key = `${accountId}_${deviceId}`;
    if (hitSoundTimers.has(key)) {
        clearTimeout(hitSoundTimers.get(key));
        hitSoundTimers.delete(key);
    }
    if (failedSoundTimers.has(key)) {
        clearTimeout(failedSoundTimers.get(key));
        failedSoundTimers.delete(key);
    }
}

// ⏱️ 启动 8 秒前置提示音超时定时器 (满8秒仅 stop 打断，不触发失败音，后台搜索继续)
function startHitSoundTimer(accountId: string, deviceId: string) {
    const key = `${accountId}_${deviceId}`;
    cancelAllTimers(accountId, deviceId);

    const timer = setTimeout(async () => {
        pushDebugLog(`⏱️ 前置提示音满 8 秒，自动下发 stop 终止打断 (后台搜索继续中)...`);
        hitSoundTimers.delete(key);
        await stopMiotPlayer(accountId, deviceId);
    }, 8000);

    hitSoundTimers.set(key, timer);
}

// ⏱️ 启动 5 秒失败提示音超时定时器 (满5秒自动 stop)
function startFailedSoundTimer(accountId: string, deviceId: string) {
    const key = `${accountId}_${deviceId}`;
    cancelAllTimers(accountId, deviceId);

    const timer = setTimeout(async () => {
        pushDebugLog(`⏱️ 失败提示音满 5 秒，自动下发 stop 停止播放`);
        failedSoundTimers.delete(key);
        await stopMiotPlayer(accountId, deviceId);
    }, 5000);

    failedSoundTimers.set(key, timer);
}

// 🌐 提取公网 IP 缓存
async function updateServerHostCache() {
    try {
        const hostUrl = await songloft.plugin.getHostUrl();
        const token = await songloft.plugin.getToken();
        const res = await fetch(`${hostUrl}/api/v1/jsplugin/miot/config`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (data?.data?.server_host) {
            cachedServerHost = data.data.server_host;
            pushDebugLog(`🌐 SongLoft主机地址: ${cachedServerHost}`);
        }
    } catch (e) {
        pushDebugLog(`⚠️ 提取SongLoft主机地址异常: ${e}`);
    }
}

// 🛑 下发小爱音箱停止播放指令
async function stopMiotPlayer(accountId: string, deviceId: string) {
    try {
        const hostUrl = await songloft.plugin.getHostUrl();
        const token = await songloft.plugin.getToken();
        const url = `${hostUrl}/api/v1/jsplugin/miot/player/stop?account_id=${accountId}&device_id=${deviceId}`;

        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-Fetch-Timeout-Ms': '1500'  // 🌟 1.5秒强制超时，绝不长期锁死VM
            },
            body: JSON.stringify({ account_id: accountId, device_id: deviceId })
        });

        if (res.ok) {
            pushDebugLog(`🛑 已下发停止指令，终止音箱播放`);
        } else {
            pushDebugLog(`⚠️ 下发停止指令失败 (HTTP ${res.status})`);
        }
    } catch (e) {
        pushDebugLog(`⚠️ 执行停止播放异常: ${e}`);
    }
}

// ⚠️ 播放失败提示音 (SongLoft_failed.3a76aaad.mp3) 并挂载 5 秒自动关停
async function playFailedSound(accountId: string, deviceId: string) {
    cancelAllTimers(accountId, deviceId);
    const failedSoundFile = 'SongLoft_failed.3a76aaad.mp3';
    pushDebugLog(`⚠️ 触发失败提示音: ${failedSoundFile}`);

    try {
        const hostUrl = await songloft.plugin.getHostUrl();
        const token = await songloft.plugin.getToken();
        const baseUrl = cachedServerHost || hostUrl;
        const soundUrl = `${baseUrl}/api/v1/jsplugin/miot-helper/static/${failedSoundFile}`;
        const targetApiUrl = `${hostUrl}/api/v1/jsplugin/miot/mina/play-url`;

        // 启动 5 秒失败音频超时关停倒计时
        startFailedSoundTimer(accountId, deviceId);

        const res = await fetch(targetApiUrl, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Fetch-Timeout-Ms': '2000' },
            body: JSON.stringify({ account_id: accountId, device_id: deviceId, url: soundUrl })
        });

        if (!res.ok) {
            pushDebugLog(`⚠️ 失败提示音播放下发失败 (HTTP ${res.status})`);
        }
    } catch (e) {
        pushDebugLog(`⚠️ 播放失败提示音异常: ${e}`);
    }
}

// 🔊 获取托管的小爱音箱名称列表
async function getMiotDeviceNames(): Promise<string> {
    try {
        const hostUrl = await songloft.plugin.getHostUrl();
        const token = await songloft.plugin.getToken();
        const res = await fetch(`${hostUrl}/api/v1/jsplugin/miot/mina/devices`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (res.ok) {
            const json = await res.json();
            if (json && json.success && Array.isArray(json.data)) {
                const deviceNames: string[] = [];
                for (const account of json.data) {
                    if (Array.isArray(account.devices)) {
                        for (const dev of account.devices) {
                            if (dev.managed === true) {
                                let devName = dev.name || dev.alias || '未命名设备';
                                if (dev.presence === 'offline') {
                                    devName += '(离线)';
                                }
                                deviceNames.push(devName);
                            }
                        }
                    }
                }
                if (deviceNames.length > 0) {
                    return deviceNames.join(', ');
                }
            }
        }
    } catch (e) {}
    return '暂无托管的小爱设备';
}

// ⚙️ 预热全局设置缓存
async function updateGlobalSettingsCache() {
    try {
        const raw = await songloft.storage.get('xiaoai_global_settings');
        if (raw) {
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (parsed && typeof parsed === 'object') {
                cachedGlobalSettings = { ...cachedGlobalSettings, ...parsed };
            }
        }
    } catch (e) {}
}

function getTargetPlaylistName(): string {
    return cachedGlobalSettings.targetPlaylist || 'iWebPlayer推送';
}

// ==========================================
// 📝 前端 Debug 日志流
// ==========================================
const debugLogs: string[] = [];
function pushDebugLog(msg: string) {
    songloft.log.info(msg);
    const d = new Date();
    const HH = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const time = `${HH}:${mm}:${ss}`;
    debugLogs.push(`[${time}] ${msg}`);
    if (debugLogs.length > 100) debugLogs.shift();
}

router.get('/logs', async (req) => { return jsonResponse({ logs: debugLogs }); });
router.delete('/logs', async (req) => { debugLogs.length = 0; return jsonResponse({ ret: "OK" }); });

// 安全写库助手
async function safeStorageSet(key: string, val: string) {
    if (typeof songloft.storage.set === 'function') await songloft.storage.set(key, val);
    else await (songloft.storage as any).setItem(key, val);
}

// 🌟 秒级触发前置语音提示音 (从内存读配置，异步非阻塞发送)
function playHitSound(accountId: string, deviceId: string) {
    const soundFile = cachedGlobalSettings.hitSound;

    // 拦截“不启用”情况
    if (!soundFile || soundFile === '' || soundFile === 'none' || soundFile === 'disabled') {
        pushDebugLog(`🔕 前置提示音已设置为 [不启用]，跳过打断`);
        return;
    }

    pushDebugLog(`🔔 触发前置提示音: ${soundFile}`);

    // 🌟 开启 8 秒防无限循环倒计时
    startHitSoundTimer(accountId, deviceId);

    (async () => {
        try {
            const hostUrl = await songloft.plugin.getHostUrl();
            const token = await songloft.plugin.getToken();

            // 优先使用动态获取的公网 server_host，取不到则降级回 hostUrl
            const baseUrl = cachedServerHost || hostUrl;
            const soundUrl = `${baseUrl}/api/v1/jsplugin/miot-helper/static/${soundFile}`;
            const targetApiUrl = `${hostUrl}/api/v1/jsplugin/miot/mina/play-url`;

            const payload = {
                account_id: accountId,
                device_id: deviceId,
                url: soundUrl
            };

            const res = await fetch(targetApiUrl, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                pushDebugLog(`⚠️ 前置提示音播放下发失败 (HTTP ${res.status})`);
            }
        } catch (e) {
            pushDebugLog(`⚠️ 播放前置提示音发生异常: ${e}`);
        }
    })();
}

// ==========================================
// 🧠 靶向智能纠错
// ==========================================
async function fetchSmartCorrection(keyword: string): Promise<string | null> {
    const url = `https://music.163.com/api/cloudsearch/pc?s=${encodeURIComponent(keyword)}&type=1&limit=1`;
    try {
        const res = await fetch(url);
        if (res.ok) {
            const data = await res.json();
            const result = data?.result;
            if (!result) return null;

            if (result.queryRewriteInfo && result.queryRewriteInfo.rewriteQuery) {
                const rewrite = result.queryRewriteInfo.rewriteQuery;
                if (rewrite !== keyword) return rewrite;
            }

            if (result.searchQcReminder && Array.isArray(result.searchQcReminder.qcReminders)) {
                for (const item of result.searchQcReminder.qcReminders) {
                    if (item.highLight && item.qcReminderPart && item.qcReminderPart !== keyword) return item.qcReminderPart;
                }
            }
        }
    } catch (e) {}
    return null;
}

// ==========================================
// 🚀 核心：全局意图路由表
// ==========================================
let voiceRoutes: Record<string, { type: string, engine: string, node: string, quality?: string, strategy?: string }> = {};

async function rebuildVoiceRoutes() {
    try {
        voiceRoutes = {};
        const wdRaw = await songloft.storage.get('xiaoai_dav_configs');
        const lxRaw = await songloft.storage.get('xiaoai_lx_configs');

        let wdConfigs = [];
        let lxConfigs = [];

        if (!wdRaw || wdRaw === 'null' || wdRaw === '[]') {
            wdConfigs = [
                { type: 'play', node: 'default', label: '播放 WebDAV 歌单口令(默认节点)', isDefault: true, cmds: ['网盘歌单'] },
                { type: 'search', node: 'default', label: '播放 WebDAV 歌曲口令(默认节点)', isDefault: true, cmds: ['网盘歌曲'] }
            ];
            await safeStorageSet('xiaoai_dav_configs', JSON.stringify(wdConfigs));
        } else {
            try { wdConfigs = typeof wdRaw === 'string' ? JSON.parse(wdRaw) : wdRaw; } catch (e) {}
            if (!Array.isArray(wdConfigs)) wdConfigs = [];
        }

        if (!lxRaw || lxRaw === 'null' || lxRaw === '[]') {
            lxConfigs = [
                { engine: 'lxmusic', type: 'play', node: 'default', quality: '320k', strategy: 'first', isDefault: true, cmds: ['搜索歌单'] },
                { engine: 'lxmusic', type: 'search', node: 'default', quality: '320k', strategy: 'first', isDefault: true, cmds: ['搜索歌曲'] }
            ];
            await safeStorageSet('xiaoai_lx_configs', JSON.stringify(lxConfigs));
        } else {
            try { lxConfigs = typeof lxRaw === 'string' ? JSON.parse(lxRaw) : lxRaw; } catch (e) {}
            if (!Array.isArray(lxConfigs)) lxConfigs = [];
        }

        const allConfigs = [...wdConfigs, ...lxConfigs];

        for (const cfg of allConfigs) {
            const engine = cfg.engine || 'webdav';
            if (Array.isArray(cfg.cmds)) {
                for (const cmd of cfg.cmds) {
                    if (cmd) voiceRoutes[cmd] = { type: cfg.type, engine, node: cfg.node, quality: cfg.quality, strategy: cfg.strategy };
                }
            }
        }

        const cmdDetails = Object.entries(voiceRoutes).map(([cmd, cfg]) => {
            const engineName = cfg.engine === 'lxmusic' ? 'LXMusic' : (cfg.engine === 'webdav' ? 'WebDAV' : cfg.engine);
            return `${cmd} (${engineName})`;
        }).join(', ');

        pushDebugLog(`✅ 口令路由表重建完成，当前挂载有效口令词共 [${Object.keys(voiceRoutes).length}] 个: ${cmdDetails}`);
    } catch (e) {
        pushDebugLog('❌ 重建口令路由表失败: ' + String(e));
    }
}

// ==========================================
// 🎵 WebDAV 推流逻辑
// ==========================================
async function createPushPlaylistAndPlay(songs: any[], accountId: string, deviceId: string) {
    if (!songs || songs.length === 0) {
        pushDebugLog('⚠️ 欲推送的歌曲列表为空，放弃建歌单');
        await playFailedSound(accountId, deviceId);
        return;
    }

    try {
        const targetPlaylistName = getTargetPlaylistName();

        const hostUrl = await songloft.plugin.getHostUrl();
        const token = await songloft.plugin.getToken();
        const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

        let oldPlaylistId: number | null = null;
        try {
            const playlists = (await songloft.playlists.list()) ?? [];
            const found = playlists.find((p: any) => p.name === targetPlaylistName);
            if (found) oldPlaylistId = found.id;
        } catch (e) {}

        if (oldPlaylistId) await fetch(`${hostUrl}/api/v1/playlists/${oldPlaylistId}`, { method: 'DELETE', headers });

        pushDebugLog(`➕ 正在创建全新推送歌单 [${targetPlaylistName}]...`);
        const createPlRes = await fetch(`${hostUrl}/api/v1/playlists`, { method: 'POST', headers, body: JSON.stringify({ name: targetPlaylistName, type: 'normal' }) });
        const newPlaylistId = (await createPlRes.json()).id;

        const songNames = songs.map(s => s.title || s.name || '未知').slice(0, 3).join(', ') + (songs.length > 3 ? ' 等' : '');
        pushDebugLog(`🔗 正在向系统注册 ${songs.length} 首远程歌曲 (${songNames})...`);

        const regRes = await fetch(`${hostUrl}/api/v1/songs/remote`, { method: 'POST', headers, body: JSON.stringify(songs) });
        const songIds = ((await regRes.json()).songs || []).map((s: any) => s.id);

        if (songIds.length > 0) {
            await fetch(`${hostUrl}/api/v1/playlists/${newPlaylistId}/songs`, { method: 'POST', headers, body: JSON.stringify({ song_ids: songIds }) });

            const firstSongName = songs[0]?.title || songs[0]?.name || '未知歌曲';
            const totalStr = songs.length > 1 ? ` 等 ${songs.length} 首歌` : '';
            pushDebugLog(`🚀 正在呼叫小爱音箱即将播放: 《${firstSongName}》${totalStr}`);

            // 🌟 即将播放正式歌曲，销毁所有前置/失败定时器
            cancelAllTimers(accountId, deviceId);

            const playRes = await fetch(`${hostUrl}/api/v1/jsplugin/miot/player/play`, {
                method: 'POST', headers, body: JSON.stringify({ account_id: accountId, device_id: deviceId, playlist_id: newPlaylistId, start_index: 0, play_mode: 'order' })
            });
            if (playRes.ok) pushDebugLog(`🎉 播放指令下发成功！尽情享受音乐吧！`);
            else {
                pushDebugLog(`❌ 小爱音箱播放指令下发失败 (HTTP ${playRes.status})`);
                await playFailedSound(accountId, deviceId);
            }
        } else {
            await playFailedSound(accountId, deviceId);
        }
    } catch (err) {
        pushDebugLog(`❌ 处理推歌异常: ` + String(err));
        await playFailedSound(accountId, deviceId);
    }
}

// 🎯 语音口令处理总入口
async function handleVoiceCommand(cmdType: string, engine: string, nodeName: string, rawKeyword: string, accountId: string, deviceId: string, quality?: string, strategy?: string) {

    // 🌟 提取全局设定的歌单名称
    const targetPlaylistName = getTargetPlaylistName();

    if (engine === 'lxmusic') {
        let actualPlatform = nodeName;
        let actualQuality = quality || '320k';
        let actualStrategy = strategy || 'first';

        if (nodeName === 'default') {
            try {
                const cfgRaw = await songloft.storage.get('lxmusic_config');
                const cfg = typeof cfgRaw === 'string' ? JSON.parse(cfgRaw) : (cfgRaw || {});
                const settings = cfg.settings || {};

                actualPlatform = String(settings.default_platform || 'wy');
                actualQuality = String(settings.default_quality || '320k');
                actualStrategy = String(settings.default_strategy || 'first');
            } catch (e) {
                actualPlatform = 'wy';
                actualQuality = '320k';
                actualStrategy = 'first';
            }

            const platMap: Record<string, string> = { wy: '网易云', tx: 'QQ音乐', kg: '酷狗', kw: '酷我', mg: '咪咕' };
            const stratMap: Record<string, string> = { first: '默认首个', random: '随机抽取', play_count: '热度优先', total: '数量优先' };
            const cnPlat = platMap[actualPlatform] || actualPlatform;
            const cnStrat = stratMap[actualStrategy] || actualStrategy;
            pushDebugLog(`⚙️ 触发全局默认策略: 平台[${cnPlat}], 音质[${actualQuality}], 策略[${cnStrat}]`);
        }

        try {
            // 🌟 将 targetPlaylistName 作为参数传入
            await handleLxMusicCommand(cmdType, actualPlatform, rawKeyword, accountId, deviceId, actualStrategy, actualQuality, targetPlaylistName, pushDebugLog);
        } catch (e) {
            pushDebugLog(`⚠️ LXMusic 执行异常: ${e}`);
            await playFailedSound(accountId, deviceId);
        }
        return;
    }

    if (cmdType === 'search') {
        pushDebugLog(`🔍 开始在 WebDAV 节点 [${nodeName}] 中匹配歌曲: "${rawKeyword}"`);
        let songs = await searchWebDavSongs(nodeName, rawKeyword, pushDebugLog);

        if (songs === null) {
            await playFailedSound(accountId, deviceId);
            return;
        }

        if (songs.length === 0) {
            pushDebugLog(`⚠️ 初始未匹配到名称包含 "${rawKeyword}" 的 WebDAV 歌曲`);
            const correction = await fetchSmartCorrection(rawKeyword);
            if (correction) {
                pushDebugLog(`💡 云端精准重写纠错: "${rawKeyword}" -> "${correction}"`);
                pushDebugLog(`🔄 使用纠错关键字 "${correction}" 再次搜索 WebDAV 歌曲...`);
                songs = await searchWebDavSongs(nodeName, correction, pushDebugLog) || [];
                if (songs.length > 0) {
                    pushDebugLog(`🎉 纠错后成功搜索到 ${songs.length} 首 WebDAV 歌曲`);
                } else {
                    pushDebugLog(`❌ 纠错关键字 "${correction}" 仍未搜到任何 WebDAV 歌曲`);
                }
            } else {
                pushDebugLog(`⚠️ 未能获得云端纠错建议`);
            }
        } else {
            pushDebugLog(`🎉 成功搜索到 ${songs.length} 首 WebDAV 歌曲`);
        }

        if (songs && songs.length > 0) {
            await createPushPlaylistAndPlay(songs, accountId, deviceId);
        } else {
            pushDebugLog(`💀 彻底未搜到关于此关键字的音乐，放弃操作`);
            await playFailedSound(accountId, deviceId); // 🌟 搜歌彻底失败，触发失败音
        }

    } else if (cmdType === 'play') {
        pushDebugLog(`📂 开始在 WebDAV 节点 [${nodeName}] 中匹配歌单: "${rawKeyword}"`);
        let realNode = nodeName;

        if (nodeName === 'default') {
            try {
                const cfgRaw = await songloft.storage.get('webdav_config');
                if (cfgRaw) {
                    const cfg = typeof cfgRaw === 'string' ? JSON.parse(cfgRaw) : cfgRaw;
                    realNode = cfg?.settings?.default_server || '';
                    if (!realNode && cfg?.roots) {
                        const availableNodes = Object.keys(cfg.roots);
                        if (availableNodes.length > 0) {
                            realNode = availableNodes[0];
                            pushDebugLog(`💡 自动将节点降级为首个可用节点: [${realNode}]`);
                        }
                    }
                }
            } catch (e) { realNode = ''; }
        }
        if (!realNode) {
            pushDebugLog(`⚠️ 未配置默认 WebDAV 节点，熔断`);
            await playFailedSound(accountId, deviceId);
            return;
        }

        const libRaw = await songloft.storage.get(`webdav_lib_${realNode}`);

        if (!libRaw) {
            pushDebugLog(`⚠️ WebDAV 节点 [${realNode}] 尚未建立曲库索引，请前往面板点击【建立全库索引】！`);
            await playFailedSound(accountId, deviceId);
            return;
        }

        const libData = typeof libRaw === 'string' ? JSON.parse(libRaw) : libRaw;
        const library = libData.library || {};

        if (Object.keys(library).length === 0) {
            pushDebugLog(`⚠️ WebDAV 节点 [${realNode}] 曲库数据为空，请前往面板检查路径并重新扫描！`);
            await playFailedSound(accountId, deviceId);
            return;
        }

        const findFolderSongs = (kw: string) => {
            const lk = kw.toLowerCase();
            for (const folder in library) if (folder.toLowerCase().includes(lk)) return { folder, songs: library[folder] || [] };
            return { folder: "", songs: [] };
        };

        let result = findFolderSongs(rawKeyword);

        if (result.songs.length === 0) {
            pushDebugLog(`⚠️ 初始未匹配到名称包含 "${rawKeyword}" 的 WebDAV 歌单`);
            const correction = await fetchSmartCorrection(rawKeyword);
            if (correction) {
                pushDebugLog(`💡 云端精准重写纠错: "${rawKeyword}" -> "${correction}"`);
                pushDebugLog(`🔄 使用纠错关键字 "${correction}" 再次匹配 WebDAV 歌单...`);
                result = findFolderSongs(correction);
                if (result.songs.length > 0) {
                    pushDebugLog(`🎉 纠错后成功匹配到歌单: [${result.folder}] (含 ${result.songs.length} 首歌曲)`);
                } else {
                    pushDebugLog(`❌ 纠错关键字 "${correction}" 仍未找到匹配的 WebDAV 歌单`);
                }
            } else {
                pushDebugLog(`⚠️ 未能获得云端纠错建议`);
            }
        } else {
            pushDebugLog(`🎉 成功匹配到歌单: [${result.folder}] (含 ${result.songs.length} 首歌曲)`);
        }

        if (result.songs.length > 0) {
            let matchedSongs = result.songs;
            if (matchedSongs.length > 500) {
                pushDebugLog(`⚠️ 该歌单曲目数超过 500 首，已自动截取前 500 首`);
                matchedSongs = matchedSongs.slice(0, 500);
            }
            await createPushPlaylistAndPlay(matchedSongs, accountId, deviceId);
        } else {
            pushDebugLog(`💀 彻底未找到匹配的歌单，放弃操作`);
            await playFailedSound(accountId, deviceId); // 🌟 匹配歌单失败，触发失败音
        }
    }
}

// === 初始化 ===
async function onInit(): Promise<void> {
    pushDebugLog('🟢 小爱语音助手后端引擎已启动');

    await updateGlobalSettingsCache(); // 预热全局设置到内存
    await updateServerHostCache();     // 预热公网 IP 到内存

    const deviceNames = await getMiotDeviceNames();
    pushDebugLog(`🔊 当前受控设备: [${deviceNames}]`);

    await rebuildVoiceRoutes();
    pushDebugLog('========================================');

    // 定时任务每 24 小时自动刷新一次 IP
    setInterval(() => {
        updateServerHostCache().catch(() => {});
    }, 24 * 60 * 60 * 1000);

    songloft.comm.onMessage("sync_webdav_data", async (payload, from) => {
        if (from !== TWIN_PLUGIN_ID) return;
        try {
            if (payload.type === 'config') {
                let localKey = payload.key;
                if (localKey === 'iwebplayer.webdav') localKey = 'webdav_config';

                await safeStorageSet(localKey, payload.value);
                if (localKey === 'xiaoai_dav_configs' || localKey === 'xiaoai_lx_configs') rebuildVoiceRoutes();
            }
            else if (payload.type === 'library' && payload.davId) {
                await safeStorageSet(`webdav_lib_${payload.davId}`, typeof payload.library === 'string' ? payload.library : JSON.stringify(payload.library));
            }
        } catch (e) {}
    });

    try {
        const hostUrl = await songloft.plugin.getHostUrl();
        const token = await songloft.plugin.getToken();
        const wsBase = hostUrl.replace(/^http/, 'ws');
        const wsUrl = `${wsBase}/api/v1/jsplugin/miot/conversation/ws?limit=50&access_token=${token}`;

        wsClient = new WebSocket(wsUrl);
        wsClient.onmessage = (event: any) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'message' && msg.data) {
                    const answers = msg.data.message?.response?.answer || [];
                    for (const a of answers) {
                        if (a.question) {
                            const fullText = a.question.trim();
                            for (const cmdPrefix in voiceRoutes) {
                                if (fullText.startsWith(cmdPrefix)) {
                                    const target = voiceRoutes[cmdPrefix];
                                    const keyword = fullText.replace(cmdPrefix, '').trim();

                                    if (keyword) {
                                        // 🌟 1. 输出命中口令日志
                                        pushDebugLog(`🎯 命中口令词: [${cmdPrefix}], 完整指令: "${fullText}"`);

                                        // 🌟 2. 从内存读配置，并发非阻塞下发打断音频，启动 8 秒倒计时
                                        playHitSound(msg.data.account_id, msg.data.device_id);

                                        // 🌟 3. 并行开始搜歌推流
                                        handleVoiceCommand(target.type, target.engine, target.node, keyword, msg.data.account_id, msg.data.device_id, target.quality, target.strategy)
                                            .catch(async () => {
                                                await playFailedSound(msg.data.account_id, msg.data.device_id);
                                            })
                                            .finally(() => {
                                                pushDebugLog('========================================');
                                            });
                                    }
                                    break;
                                }
                            }
                        }
                    }
                }
            } catch (e) { }
        };
    } catch (e) { }
}

async function onDeinit(): Promise<void> {
    if (wsClient) { wsClient.close(); wsClient = null; }
}

async function onHTTPRequest(req: HTTPRequest): Promise<HTTPResponse> {
    return await router.handle(req);
}

router.get('/store', async (req) => {
    const q = parseQuery(req.query);
    const key = q.key as string;
    if (!key) return jsonResponse({ error: "Missing key" }, 400);
    const valRaw = await songloft.storage.get(key);
    const val = typeof valRaw === 'string' ? valRaw : JSON.stringify(valRaw);
    return jsonResponse({ data: val || '' });
});

router.post('/store', async (req) => {
    try {
        const body = req.body ? JSON.parse(typeof req.body === 'string' ? req.body : String.fromCharCode.apply(null, Array.from(req.body as Uint8Array))) : {};
        const key = body.key;
        const value = body.value;
        if (!key) return jsonResponse({ error: "Missing key" }, 400);

        await safeStorageSet(key, value);

        if (key === 'xiaoai_global_settings') {
            await updateGlobalSettingsCache(); // 🌟 前端更改设置时立刻刷新内存
        }

        if (key === 'xiaoai_dav_configs' || key === 'xiaoai_lx_configs') rebuildVoiceRoutes();

        let syncKey = key;
        if (key === 'webdav_config') syncKey = 'iwebplayer.webdav';

        if (key === 'webdav_config' || key === 'xiaoai_dav_configs' || key === 'xiaoai_lx_configs' || key.startsWith('webdav_lib_')) {
            songloft.comm.send(TWIN_PLUGIN_ID, "sync_webdav_data", { type: 'config', key: syncKey, value: value }).catch(()=>{});
        }
        return jsonResponse({ ret: "OK" });
    } catch (e) { return jsonResponse({ error: String(e) }, 500); }
});

setupWebDAVRoutes(router);

// @ts-expect-error
globalThis.onInit = onInit;
// @ts-expect-error
globalThis.onDeinit = onDeinit;
// @ts-expect-error
globalThis.onHTTPRequest = onHTTPRequest;