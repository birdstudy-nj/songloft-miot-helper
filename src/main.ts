/// <reference types="@songloft/plugin-sdk" />
import { jsonResponse, createRouter, parseQuery } from '@songloft/plugin-sdk';
import type { HTTPRequest, HTTPResponse } from '@songloft/plugin-sdk';
import { setupWebDAVRoutes, searchWebDavSongs } from './webdav';
import { handleLxMusicCommand } from './lxmusic';

const router = createRouter();
let wsClient: any = null;
const TWIN_PLUGIN_ID = 'iwebplayer';

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
    if (!songs || songs.length === 0) { pushDebugLog('⚠️ 欲推送的歌曲列表为空，放弃建歌单'); return; }

    try {
        const hostUrl = await songloft.plugin.getHostUrl();
        const token = await songloft.plugin.getToken();
        const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

        let oldPlaylistId: number | null = null;
        try {
            const playlists = (await songloft.playlists.list()) ?? [];
            const found = playlists.find((p: any) => p.name === 'iWebPlayer推送');
            if (found) oldPlaylistId = found.id;
        } catch (e) {}

        if (oldPlaylistId) await fetch(`${hostUrl}/api/v1/playlists/${oldPlaylistId}`, { method: 'DELETE', headers });

        pushDebugLog(`➕ 正在创建全新推送歌单...`);
        const createPlRes = await fetch(`${hostUrl}/api/v1/playlists`, { method: 'POST', headers, body: JSON.stringify({ name: 'iWebPlayer推送', type: 'normal' }) });
        const newPlaylistId = (await createPlRes.json()).id;

        const songNames = songs.map(s => s.title || s.name || '未知').slice(0, 3).join(', ') + (songs.length > 3 ? ' 等' : '');
        pushDebugLog(`🔗 正在向系统注册 ${songs.length} 首远程歌曲 (如: ${songNames})...`);

        const regRes = await fetch(`${hostUrl}/api/v1/songs/remote`, { method: 'POST', headers, body: JSON.stringify(songs) });
        const songIds = ((await regRes.json()).songs || []).map((s: any) => s.id);

        if (songIds.length > 0) {
            await fetch(`${hostUrl}/api/v1/playlists/${newPlaylistId}/songs`, { method: 'POST', headers, body: JSON.stringify({ song_ids: songIds }) });

            const firstSongName = songs[0]?.title || songs[0]?.name || '未知歌曲';
            const totalStr = songs.length > 1 ? ` 等 ${songs.length} 首歌` : '';
            pushDebugLog(`🚀 正在呼叫小爱音箱即将播放: 《${firstSongName}》${totalStr}`);

            const playRes = await fetch(`${hostUrl}/api/v1/jsplugin/miot/player/play`, {
                method: 'POST', headers, body: JSON.stringify({ account_id: accountId, device_id: deviceId, playlist_id: newPlaylistId, start_index: 0, play_mode: 'order' })
            });
            if (playRes.ok) pushDebugLog(`🎉 播放指令下发成功！尽情享受音乐吧！`);
            else pushDebugLog(`❌ 小爱音箱播放指令下发失败 (HTTP ${playRes.status})`);
        }
    } catch (err) { pushDebugLog(`❌ 处理推歌异常: ` + String(err)); }
}

// 🎯 语音口令处理总入口
async function handleVoiceCommand(cmdType: string, engine: string, nodeName: string, rawKeyword: string, accountId: string, deviceId: string, quality?: string, strategy?: string) {
    if (engine === 'lxmusic') {
        let actualPlatform = nodeName;
        let actualQuality = quality || '320k';
        let actualStrategy = strategy || 'first';

        if (nodeName === 'default') {
            // 🌟 纯净新版：读取聚合的 lxmusic_config
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

        await handleLxMusicCommand(cmdType, actualPlatform, rawKeyword, accountId, deviceId, actualStrategy, actualQuality, pushDebugLog);
        return;
    }

    if (cmdType === 'search') {
        pushDebugLog(`🔍 开始在 WebDAV 节点 [${nodeName}] 中匹配歌曲: "${rawKeyword}"`);
        // 🌟 将 pushDebugLog 传给搜歌函数，让其能在底层打印诊断日志
        let songs = await searchWebDavSongs(nodeName, rawKeyword, pushDebugLog);

        // 💡 如果返回 null，代表发生了“没建索引”等致命错误，直接熔断，不再走纠错逻辑
        if (songs === null) return;

        if (songs.length === 0) {
            const correction = await fetchSmartCorrection(rawKeyword);
            if (correction) {
                pushDebugLog(`💡 云端精准重写纠错: "${rawKeyword}" -> "${correction}"`);
                songs = await searchWebDavSongs(nodeName, correction, pushDebugLog) || [];
            }
        }
        if (songs && songs.length > 0) await createPushPlaylistAndPlay(songs, accountId, deviceId);
        else pushDebugLog(`💀 彻底未搜到关于此关键字的音乐，放弃操作`);

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
        if (!realNode) { pushDebugLog(`⚠️ 未配置默认 WebDAV 节点，熔断`); return; }

        const libRaw = await songloft.storage.get(`webdav_lib_${realNode}`);

        // 🌟 核心改进：当没有曲库时，大声在控制台喊出来，而不是默默退出！
        if (!libRaw) {
            pushDebugLog(`⚠️ WebDAV 节点 [${realNode}] 尚未建立曲库索引，请前往面板点击【建立全库索引】！`);
            return;
        }

        const libData = typeof libRaw === 'string' ? JSON.parse(libRaw) : libRaw;
        const library = libData.library || {};

        if (Object.keys(library).length === 0) {
            pushDebugLog(`⚠️ WebDAV 节点 [${realNode}] 曲库数据为空，请前往面板检查路径并重新扫描！`);
            return;
        }

        const findFolderSongs = (kw: string) => {
            const lk = kw.toLowerCase();
            for (const folder in library) if (folder.toLowerCase().includes(lk)) return { folder, songs: library[folder] || [] };
            return { folder: "", songs: [] };
        };

        let result = findFolderSongs(rawKeyword);
        if (result.songs.length === 0) {
            const correction = await fetchSmartCorrection(rawKeyword);
            if (correction) {
                pushDebugLog(`💡 云端精准重写纠错: "${rawKeyword}" -> "${correction}"`);
                result = findFolderSongs(correction);
            }
        }

        if (result.songs.length > 0) {
            let matchedSongs = result.songs;
            if (matchedSongs.length > 500) matchedSongs = matchedSongs.slice(0, 500);
            await createPushPlaylistAndPlay(matchedSongs, accountId, deviceId);
        } else pushDebugLog(`💀 彻底未找到匹配的歌单，放弃操作`);
    }
}

// === 初始化 ===
async function onInit(): Promise<void> {
    pushDebugLog('🟢 小爱语音助手后端引擎已启动');
    await rebuildVoiceRoutes();

    songloft.comm.onMessage("sync_webdav_data", async (payload, from) => {
        if (from !== TWIN_PLUGIN_ID) return;
        try {
            if (payload.type === 'config') {
                // 🌟 反向同步映射：iwebplayer.webdav 存入本地应叫 webdav_config
                let localKey = payload.key;
                if (localKey === 'iwebplayer.webdav') localKey = 'webdav_config';

                await safeStorageSet(localKey, payload.value);
                if (localKey === 'xiaoai_dav_configs' || localKey === 'xiaoai_lx_configs') rebuildVoiceRoutes();
            }
            else if (payload.type === 'library' && payload.davId) {
                // 🌟 新版曲库格式直接全量覆盖落盘
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
                                    pushDebugLog(`🗣️ 听到指令: "${fullText}"`);

                                    if (keyword) {
                                        handleVoiceCommand(target.type, target.engine, target.node, keyword, msg.data.account_id, msg.data.device_id, target.quality, target.strategy)
                                            .catch(() => {})
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

        if (key === 'xiaoai_dav_configs' || key === 'xiaoai_lx_configs') rebuildVoiceRoutes();

        // 🌟 根据规范推送给 iWebPlayer，动态改名
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