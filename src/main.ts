/// <reference types="@songloft/plugin-sdk" />
import { jsonResponse, createRouter, parseQuery } from '@songloft/plugin-sdk';
import type { HTTPRequest, HTTPResponse } from '@songloft/plugin-sdk';
import { setupWebDAVRoutes, searchWebDavSongs } from './webdav';
import { searchLxMusicSongs } from './lxmusic';

const router = createRouter();
let wsClient: any = null;
const TWIN_PLUGIN_ID = 'iwebplayer';
let cachedServerHost = '';

// ==========================================
// 🌟 全局默认配置常量 (单点事实)
// ==========================================
const DEF_SHUFFLE = ['随机', '乱序'];
const DEF_PREFIX = ['前', '截取'];
const DEF_SUFFIX = ['首', '首歌'];
const DEF_LIMIT = 500;
const DEF_ENABLE_SHUFFLE = true;
const DEF_ENABLE_LIMIT = true;

let cachedGlobalSettings: any = {
    targetPlaylist: 'iWebPlayer推送',
    hitSound: 'SongLoft_for_u.a2ac34c5.mp3',
    summaryTTS: 'on',
    shuffleWords: [...DEF_SHUFFLE],
    limitPrefixes: [...DEF_PREFIX],
    limitSuffixes: [...DEF_SUFFIX],
    defaultLimit: DEF_LIMIT
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

// ==========================================
// 🌐 提取公网 IP 缓存 (后台定时抓取守护进程)
// ==========================================
async function updateServerHostCache() {
    try {
        const hostUrl = await songloft.plugin.getHostUrl();
        const token = await songloft.plugin.getToken();
        const res = await fetch(`${hostUrl}/api/v1/jsplugin/miot/config`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'X-Fetch-Timeout-Ms': '3000'
            }
        });
        if (res.ok) {
            const data = await res.json();
            if (data?.data?.server_host) {
                cachedServerHost = data.data.server_host;
            }
        }
    } catch (e) {}
}

// 🌟 独立封装的 IP 刷新守护进程
function startServerHostDaemon() {
    setTimeout(() => {
        updateServerHostCache().catch(() => {});
    }, 30 * 1000);

    setInterval(() => {
        updateServerHostCache().catch(() => {});
    }, 24 * 60 * 60 * 1000);
}

// ==========================================
// 📡 插件间数据同步消息监听器
// ==========================================
function setupCommSyncListeners() {
    songloft.comm.onMessage("sync_webdav_data", async (payload, from) => {
        if (from !== TWIN_PLUGIN_ID) return;
        try {
            if (payload.type === 'config') {
                let localKey = payload.key;
                if (localKey === 'iwebplayer.webdav') localKey = 'webdav_config';

                await safeStorageSet(localKey, payload.value);
                if (localKey === 'xiaoai_dav_configs' || localKey === 'xiaoai_lx_configs') {
                    rebuildVoiceRoutes();
                }
            }
            else if (payload.type === 'library' && payload.davId) {
                await safeStorageSet(`webdav_lib_${payload.davId}`, typeof payload.library === 'string' ? payload.library : JSON.stringify(payload.library));
            }
        } catch (e) {}
    });
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
                'X-Fetch-Timeout-Ms': '1500'
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

    if (!soundFile || soundFile === '' || soundFile === 'none' || soundFile === 'disabled') {
        pushDebugLog(`🔕 前置提示音已设置为 [不启用]，跳过打断`);
        return;
    }

    pushDebugLog(`🔔 触发前置提示音: ${soundFile}`);
    startHitSoundTimer(accountId, deviceId);

    (async () => {
        try {
            const hostUrl = await songloft.plugin.getHostUrl();
            const token = await songloft.plugin.getToken();
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
// 🧠 语音智能解析 (NLP) & 平台词提取
// ==========================================
const PLAT_MAP: Record<string, string> = { wy: '网易云', tx: 'QQ音乐', kg: '酷狗', kw: '酷我', mg: '咪咕' };
const PLAT_WORDS: Record<string, string[]> = {
    tx: ['qq音乐', '腾讯音乐', 'q音乐', 'qq', '腾讯'],
    kg: ['酷狗音乐', '酷狗'],
    kw: ['酷我音乐', '酷我'],
    wy: ['网易云音乐', '网易云', '云音乐', '网易'],
    mg: ['咪咕音乐', '咪咕']
};

// 预处理匹配表：最长匹配优先，防止短词误杀长词
const PLAT_MATCHER = (() => {
    const arr: [string, string][] = [];
    for (const p in PLAT_WORDS) for (const w of PLAT_WORDS[p]) arr.push([p, w]);
    arr.sort((a, b) => b[1].length - a[1].length);
    return arr;
})();

function extractPlatform(text: string) {
    let platform: string | null = null;
    let rest = text || '';
    for (const [p, w] of PLAT_MATCHER) {
        const idx = rest.indexOf(w);
        if (idx >= 0) {
            platform = p;
            rest = (rest.slice(0, idx) + rest.slice(idx + w.length)).trim();
            break;
        }
    }
    return { platform, keyword: rest.trim() };
}

const VERB_TOKENS = ['播放', '搜索']; // 恢复原样，把乱序剥离任务交给动态配置
const CONNECTIVE_TRIM = ['中的', '里面', '里的', '里', '的', '中', '上', '下', '之'];

function stripEdges(s: string) {
    let changed = true;
    while (changed) {
        changed = false;
        for (const c of CONNECTIVE_TRIM) {
            if (s.startsWith(c)) { s = s.slice(c.length); changed = true; break; }
            if (s.endsWith(c)) { s = s.slice(0, s.length - c.length); changed = true; break; }
        }
    }
    return s;
}

// 解析整句：意图命中 + 提取平台 + 提取动态乱序 + 提取动态截断 + 去废话
function parseVoiceCommand(query: string) {
    const trimmed = (query || '').trim();
    if (!trimmed) return null;

    // 🌟 1. 动态提取并抠除“乱序/随机”指令词
    let shuffleFlag = false;
    let textToParse = trimmed;

    if (cachedGlobalSettings.enableShuffle !== false) {
        const shuffleWords = Array.isArray(cachedGlobalSettings.shuffleWords) && cachedGlobalSettings.shuffleWords.length > 0 ? cachedGlobalSettings.shuffleWords : DEF_SHUFFLE;
        for (const sw of shuffleWords) {
            if (textToParse.includes(sw)) {
                shuffleFlag = true;
                textToParse = textToParse.split(sw).join('');
            }
        }
    }

    // 2. 寻找被包含的最长口令词
    let best: any = null, bestLen = 0, matchedWord = '';
    for (const w in voiceRoutes) {
        if (w && textToParse.includes(w) && w.length > bestLen) {
            bestLen = w.length; best = voiceRoutes[w]; matchedWord = w;
        }
    }
    if (!best) return null;

    // 3. 提取平台词并抠除
    const ep = extractPlatform(textToParse);
    let kw = ep.keyword.split(matchedWord).join('');

    // 4. 去除动词和连词废话
    for (const v of VERB_TOKENS) kw = kw.split(v).join('');
    kw = stripEdges(kw.trim()).trim();

    // 🌟 5. 全局动态数量提取引擎 (智能双端触碰算法)
    let limit = 0;

    if (cachedGlobalSettings.enableLimit !== false) {
        const limitPrefixes = Array.isArray(cachedGlobalSettings.limitPrefixes) && cachedGlobalSettings.limitPrefixes.length > 0 ? cachedGlobalSettings.limitPrefixes : DEF_PREFIX;
        const limitSuffixes = Array.isArray(cachedGlobalSettings.limitSuffixes) && cachedGlobalSettings.limitSuffixes.length > 0 ? cachedGlobalSettings.limitSuffixes : DEF_SUFFIX;

        const prefixStr = limitPrefixes.join('|');
        const suffixStr = limitSuffixes.join('|');

        // 构建头部触碰和尾部触碰的动态正则
        const endRegex = new RegExp(`(?:${prefixStr})?(\\d+|[一二两三四五六七八九十]+)\\s*(?:${suffixStr})$`);
        const startRegex = new RegExp(`^(?:${prefixStr})?(\\d+|[一二两三四五六七八九十]+)\\s*(?:${suffixStr})`);

        // 优先检测尾部（解决包含数量词的歌名问题），如果尾部没有，再检测头部
        let limitMatch = kw.match(endRegex);
        if (!limitMatch) {
            limitMatch = kw.match(startRegex);
        }

        if (limitMatch) {
            const numStr = limitMatch[1];
            if (/^\d+$/.test(numStr)) {
                limit = parseInt(numStr, 10);
            } else {
                const zhMap: Record<string, number> = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
                if (numStr.length === 1) limit = zhMap[numStr] || 0;
                else if (numStr.length === 2 && numStr[0] === '十') limit = 10 + (zhMap[numStr[1]] || 0);
                else if (numStr.length === 2 && numStr[1] === '十') limit = (zhMap[numStr[0]] || 0) * 10;
                else if (numStr.length === 3 && numStr[1] === '十') limit = (zhMap[numStr[0]] || 0) * 10 + (zhMap[numStr[2]] || 0);
                else limit = cachedGlobalSettings.defaultLimit || DEF_LIMIT;
            }
            // 成功抠出数字后，将其从关键字中剔除，留下纯净的歌名
            kw = kw.replace(limitMatch[0], '').trim();
        } else {
            // 🌟 核心逻辑：如果语音没带数量，优先看这个独立口令有没有配置 limit，没有再走全局兜底
            limit = best.limit ? best.limit : (cachedGlobalSettings.defaultLimit || DEF_LIMIT);
        }
    } else {
        // 如果开关未启用，直接赋默认值，原封不动保留 keyword
        // 但此时我们仍然要尊重该独立口令可能配置的特殊 limit
        limit = best.limit ? best.limit : (cachedGlobalSettings.defaultLimit || DEF_LIMIT);
    }

    // 🌟 核心逻辑：如果语音没说乱序，看看这个独立口令有没有强行开启乱序
    const finalShuffle = shuffleFlag || !!best.shuffle;

    // 👇 重点修改在这里：判断如果有固定关键字，绝对霸权覆盖掉用户说的词！
    if (best.fixedKeyword) {
        kw = best.fixedKeyword;
    }

    return {
        type: best.type, engine: best.engine, node: best.node,
        quality: best.quality, strategy: best.strategy,
        platform: ep.platform, keyword: kw, matchedWord,
        limit,
        shuffleFlag: finalShuffle // 🌟 传出最终运算后的乱序标记
    };
}


// ==========================================
// 🚀 核心：全局意图路由表
// ==========================================
let voiceRoutes: Record<string, { type: string, engine: string, node: string, quality?: string, strategy?: string, limit?: number, shuffle?: boolean, fixedKeyword?: string }> = {};

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

        // 🌟 5 大默认指令定义
        const defaultLx = [
            { engine: 'lxmusic', type: 'play', node: 'default', quality: '320k', strategy: 'first', isDefault: true, cmds: ['搜索歌单'] },
            { engine: 'lxmusic', type: 'search', node: 'default', quality: '320k', strategy: 'first', isDefault: true, cmds: ['搜索歌曲'] },
            { engine: 'lxmusic', type: 'singer', node: 'default', quality: '320k', strategy: 'first', isDefault: true, cmds: ['搜索歌手'] },
            { engine: 'lxmusic', type: 'album', node: 'default', quality: '320k', strategy: 'first', isDefault: true, cmds: ['搜索专辑'] },
            { engine: 'lxmusic', type: 'rank', node: 'default', quality: '320k', strategy: 'first', isDefault: true, cmds: ['搜索榜单'] }

        ];

        if (!lxRaw || lxRaw === 'null' || lxRaw === '[]') {
            // 全新安装：全部注入
            lxConfigs = [...defaultLx];
            await safeStorageSet('xiaoai_lx_configs', JSON.stringify(lxConfigs));
        } else {
            // 升级覆盖：查漏补缺
            try { lxConfigs = typeof lxRaw === 'string' ? JSON.parse(lxRaw) : lxRaw; } catch (e) {}
            if (!Array.isArray(lxConfigs)) lxConfigs = [];

            let added = false;
            for (const d of defaultLx) {
                if (!lxConfigs.find(c => c.isDefault && c.type === d.type && c.engine === d.engine)) {
                    lxConfigs.push(d);
                    added = true;
                }
            }
            if (added) await safeStorageSet('xiaoai_lx_configs', JSON.stringify(lxConfigs));
        }

        const allConfigs = [...wdConfigs, ...lxConfigs];

        for (const cfg of allConfigs) {
            // 🌟 拦截被禁用的口令组，如果设为 false 则直接跳过，不挂载到路由表
            if (cfg.enabled === false) continue;

            const engine = cfg.engine || 'webdav';
            if (Array.isArray(cfg.cmds)) {
                for (const cmd of cfg.cmds) {
                    if (cmd) {
                        // 👇 如果启用了，就把关键字拿出来；否则置空
                        const fixedKeyword = cfg.enableFixedKeyword && cfg.fixedKeyword ? cfg.fixedKeyword : undefined;
                        voiceRoutes[cmd] = { type: cfg.type, engine, node: cfg.node, quality: cfg.quality, strategy: cfg.strategy, limit: cfg.limit, shuffle: cfg.shuffle, fixedKeyword };
                    }
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
// 🎵 统一推流与入库调度指挥中枢 (并行流水线模式)
// ==========================================
async function createPushPlaylistAndPlay(songs: any[], accountId: string, deviceId: string, engine: string, collectionName: string = "") {
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

        // ====================================
        // 🌟 提前并行的 TTS 播报环节
        // ====================================
        const firstSong = songs[0];
        const artist = (firstSong?.artist || firstSong?.singer || '').trim();
        const title = (firstSong?.title || firstSong?.name || '未知歌曲').trim();
        const count = songs.length;
        const totalStr = count > 1 ? ` 等 ${count} 首歌` : '';

        pushDebugLog(`🚀 正在准备推送: 《${title}》${totalStr}`);
        cancelAllTimers(accountId, deviceId);

        let expectedTtsDelayMs = 0;
        let ttsStartTime = Date.now(); // 记录起跑时间

        if (cachedGlobalSettings.summaryTTS !== 'off') {
            let playSuffix = "";
            if (!artist || artist === '未知歌手') {
                playSuffix = `歌曲 ${title}`;
            } else {
                playSuffix = `${artist}的${title}`;
            }

            let ttsText = collectionName
                ? `匹配到歌单${collectionName}，共${count}首，即将播放${playSuffix}`
                : `匹配到${count}首，即将播放${playSuffix}`;

            pushDebugLog(`📣 提前触发总汇报 TTS 播报: ${ttsText}`);

            const zhCount = (ttsText.match(/[\u4e00-\u9fa5]/g) || []).length;
            const enWordCount = (ttsText.match(/[a-zA-Z0-9]+/g) || []).length;
            const totalSyllables = zhCount + (enWordCount * 2);
            expectedTtsDelayMs = Math.ceil(totalSyllables / 4.5) * 1000 + 1500;

            // ⚠️ 重点：这里直接 fetch 发送，不再 await 阻塞！
            // 让请求发出去后代码立刻往下走，实现"小爱说话"和"后台建单"双管齐下！
            fetch(`${hostUrl}/api/v1/jsplugin/miot/mina/tts`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ account_id: accountId, device_id: deviceId, text: ttsText })
            }).then(res => {
                if (!res.ok) pushDebugLog(`⚠️ TTS 发送失败 (HTTP ${res.status})`);
            }).catch(e => pushDebugLog(`⚠️ TTS 发生异常: ${e}`));

            const delaySec = (expectedTtsDelayMs / 1000).toFixed(1);
            pushDebugLog(`⏳ TTS 已异步下发，预计耗时 ${delaySec} 秒 (期间后台将同步执行建单入库)...`);
        }

        // ====================================
        // 1. [统一环节] 一步到位删除旧歌单及连带歌曲
        // ====================================
        let oldPlaylistId: number | null = null;
        try {
            const playlists = (await songloft.playlists.list()) ?? [];
            const found = playlists.find((p: any) => p.name === targetPlaylistName);
            if (found) oldPlaylistId = found.id;
        } catch (e) {}

        if (oldPlaylistId) {
            pushDebugLog(`🧹 正在清理旧推送歌单 [${targetPlaylistName}](ID: ${oldPlaylistId}) 及其连带歌曲...`);
            await fetch(`${hostUrl}/api/v1/playlists/${oldPlaylistId}?delete_songs=true`, { method: 'DELETE', headers });
        }

        // ====================================
        // 2. [统一环节] 创建全新歌单
        // ====================================
        pushDebugLog(`➕ 正在创建全新推送歌单 [${targetPlaylistName}]...`);
        const createPlRes = await fetch(`${hostUrl}/api/v1/playlists`, { method: 'POST', headers, body: JSON.stringify({ name: targetPlaylistName, type: 'normal' }) });
        const newPlaylistId = (await createPlRes.json()).id;
        const songNames = songs.map(s => s.title || s.name || '未知').slice(0, 3).join(', ') + (songs.length > 3 ? ' 等' : '');

        // ====================================
        // 3. [分流环节] 尊重各引擎独特的入库协议
        // ====================================
        let isImportSuccess = false;

        if (engine === 'lxmusic') {
            pushDebugLog(`🔗 [LXMusic通道] 正在通过专属接口导入 ${songs.length} 首歌曲 (${songNames})...`);
            const importRes = await fetch(`${hostUrl}/api/v1/jsplugin/lxmusic/api/songs/import`, {
                method: 'POST', headers, body: JSON.stringify({ songs: songs, playlist_id: String(newPlaylistId), new_playlist_name: "" })
            });
            if (importRes.ok) {
                const importData = await importRes.json();
                pushDebugLog(`✅ 成功导入并绑定 ${importData?.data?.success || 0} 首歌进歌单！`);
                isImportSuccess = true;
            } else {
                throw new Error(`LXMusic 歌曲导入失败 (HTTP ${importRes.status})`);
            }

        } else if (engine === 'webdav') {
            pushDebugLog(`🔗 [WebDAV通道] 正在向系统注册 ${songs.length} 首远程歌曲 (${songNames})...`);
            const regRes = await fetch(`${hostUrl}/api/v1/songs/remote`, { method: 'POST', headers, body: JSON.stringify(songs) });
            const songIds = ((await regRes.json()).songs || []).map((s: any) => s.id);

            if (songIds.length > 0) {
                await fetch(`${hostUrl}/api/v1/playlists/${newPlaylistId}/songs`, { method: 'POST', headers, body: JSON.stringify({ song_ids: songIds }) });
                isImportSuccess = true;
            }

        } else {
            pushDebugLog(`⚠️ 尚未实现引擎 [${engine}] 的入库逻辑，已跳过`);
        }

        // ====================================
        // 4. [统一环节] 下发小爱设备播放
        // ====================================
        if (isImportSuccess) {
            // 🌟 结算环节：算算后台干活花了多久，把这部分时间抵扣掉
            if (expectedTtsDelayMs > 0) {
                const elapsed = Date.now() - ttsStartTime; // 后台跑了多长时间
                const remaining = expectedTtsDelayMs - elapsed; // TTS 还剩多少时间没念完

                if (remaining > 0) {
                    pushDebugLog(`⏳ 入库等前置操作耗时 ${(elapsed / 1000).toFixed(1)} 秒，继续等待 TTS 播完剩余的 ${(remaining / 1000).toFixed(1)} 秒...`);
                    await new Promise(r => setTimeout(r, remaining));
                } else {
                    pushDebugLog(`⏳ 入库耗时 ${(elapsed / 1000).toFixed(1)} 秒，已完全覆盖 TTS 时长，无需挂起，立即下发播放指令！`);
                }
            }

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
async function handleVoiceCommand(cmdType: string, engine: string, nodeName: string, rawKeyword: string, accountId: string, deviceId: string, quality?: string, strategy?: string, parsedPlatform?: string | null, shuffleFlag?: boolean, parsedLimit?: number) {
    const doShuffle = !!shuffleFlag;

    // === LXMusic 处理分支 ===
    if (engine === 'lxmusic') {
        let actualPlatform = nodeName;
        let actualQuality = quality || '320k';
        let actualStrategy = strategy || 'first';

        if (parsedPlatform) {
            actualPlatform = parsedPlatform; // 🌟 语音显式指定的平台词优先级最高
            pushDebugLog(`🎯 语音平台词命中: [${PLAT_MAP[actualPlatform] || actualPlatform}]，覆盖节点配置`);
        } else if (nodeName === 'default') {
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
            // 👇 修改：接收返回的对象
            const searchRes = await searchLxMusicSongs(cmdType, actualPlatform, rawKeyword, actualStrategy, actualQuality, pushDebugLog);

            if (searchRes === null || searchRes.songs.length === 0) {
                await playFailedSound(accountId, deviceId);
            } else {
                const songs = searchRes.songs;
                const collectionName = searchRes.collectionName; // 👇 提取出歌单名

                let effectiveLimit = (parsedLimit && parsedLimit > 0) ? parsedLimit : (cachedGlobalSettings.defaultLimit || 500);
                let finalSongs = doShuffle && songs.length > 1 ? songs.slice().sort(() => Math.random() - 0.5) : songs;
                if (doShuffle && songs.length > 1) pushDebugLog(`🎲 已开启随机播放，打乱 ${songs.length} 首歌曲顺序`);

                // 🌟 统一截取逻辑
                if (finalSongs.length > effectiveLimit) {
                    pushDebugLog(`✂️ 触发数量限制: 已截取前 ${effectiveLimit} 首歌曲`);
                    finalSongs = finalSongs.slice(0, effectiveLimit);
                }

                // 👇 修改：把歌单名传给最终的推流大管家
                await createPushPlaylistAndPlay(finalSongs, accountId, deviceId, 'lxmusic', collectionName);
            }
        } catch (e) {
            pushDebugLog(`⚠️ LXMusic 执行异常: ${e}`);
            await playFailedSound(accountId, deviceId);
        }
        return;
    }

    // === WebDAV 处理分支 ===
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
            let effectiveLimit = (parsedLimit && parsedLimit > 0) ? parsedLimit : (cachedGlobalSettings.defaultLimit || 500);
            let finalSongs = doShuffle && songs.length > 1 ? songs.slice().sort(() => Math.random() - 0.5) : songs;
            if (doShuffle && songs.length > 1) pushDebugLog(`🎲 已开启随机播放，打乱 ${songs.length} 首歌曲顺序`);

            if (finalSongs.length > effectiveLimit) {
                pushDebugLog(`✂️ 触发数量限制: 已截取前 ${effectiveLimit} 首歌曲`);
                finalSongs = finalSongs.slice(0, effectiveLimit);
            }

            await createPushPlaylistAndPlay(finalSongs, accountId, deviceId, 'webdav', "");
        } else {
            pushDebugLog(`💀 彻底未搜到关于此关键字的音乐，放弃操作`);
            await playFailedSound(accountId, deviceId);
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

            let effectiveLimit = (parsedLimit && parsedLimit > 0) ? parsedLimit : (cachedGlobalSettings.defaultLimit || 500);
            let finalSongs = doShuffle && matchedSongs.length > 1 ? matchedSongs.slice().sort(() => Math.random() - 0.5) : matchedSongs;
            if (doShuffle && matchedSongs.length > 1) pushDebugLog(`🎲 已开启随机播放，打乱 ${matchedSongs.length} 首歌曲顺序`);

            if (finalSongs.length > effectiveLimit) {
                pushDebugLog(`✂️ 触发数量限制: 已截取前 ${effectiveLimit} 首歌曲`);
                finalSongs = finalSongs.slice(0, effectiveLimit);
            }

            await createPushPlaylistAndPlay(finalSongs, accountId, deviceId, 'webdav', result.folder);
        } else {
            pushDebugLog(`💀 彻底未找到匹配的歌单，放弃操作`);
            await playFailedSound(accountId, deviceId);
        }
    }
}

// ==========================================
// 🔌 WebSocket 连接与断线重连守护
// ==========================================
let reconnectTimer: any = null;

function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectWebSocket();
    }, 5000);
}

async function connectWebSocket() {
    try {
        if (wsClient) {
            wsClient.close();
            wsClient = null;
        }

        const hostUrl = await songloft.plugin.getHostUrl();
        const token = await songloft.plugin.getToken();
        const wsBase = hostUrl.replace(/^http/, 'ws');
        const wsUrl = `${wsBase}/api/v1/jsplugin/miot/conversation/ws?limit=50&access_token=${token}`;

        wsClient = new WebSocket(wsUrl);

        wsClient.onopen = () => {
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
        };

        wsClient.onmessage = (event: any) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'message' && msg.data) {
                    // 🌟 兼容新版 MIoT 插件扁平化结构 (直接读取 query 字段)
                    let fullText = msg.data.query;

                    // 🌟 兼容旧版深层嵌套结构 (防错兜底)
                    if (!fullText && msg.data.message?.response?.answer) {
                        const answers = msg.data.message.response.answer;
                        if (answers.length > 0) fullText = answers[0].question;
                    }

                    if (fullText && typeof fullText === 'string') {
                        const trimmedText = fullText.trim();

                        // 🌟 调用全新 NLP 引擎解析指令
                        const parsed = parseVoiceCommand(trimmedText);

                        if (parsed) {
                            if (parsed.keyword) {
                                // 正常流程：有关键词，继续搜歌
                                const platDesc = parsed.platform ? ` 平台词: [${PLAT_MAP[parsed.platform] || parsed.platform}]` : '';
                                pushDebugLog(`🎯 命中口令词: [${parsed.matchedWord}], 完整指令: "${trimmedText}"${platDesc}`);
                                playHitSound(msg.data.account_id, msg.data.device_id);

                                // 传入解析好的参数
                                handleVoiceCommand(parsed.type, parsed.engine, parsed.node, parsed.keyword, msg.data.account_id, msg.data.device_id, parsed.quality, parsed.strategy, parsed.platform, parsed.shuffleFlag, parsed.limit)
                                    .catch(async () => {
                                        await playFailedSound(msg.data.account_id, msg.data.device_id);
                                    })
                                    .finally(() => {
                                        pushDebugLog('========================================');
                                    });
                            } else {
                                // 🌟 新增：空指令拦截流程 (只听到口令，没有后续内容)
                                pushDebugLog(`⚠️ 拦截到空指令：只听到口令[${parsed.matchedWord}]，无后续关键词。`);
                                pushDebugLog('========================================');

                                // 启动一个异步闭包发送 TTS 语音，不阻塞 WebSocket 主线程
                                (async () => {
                                    try {
                                        const hostUrl = await songloft.plugin.getHostUrl();
                                        const token = await songloft.plugin.getToken();
                                        const ttsText = `语音助手只听到，${parsed.matchedWord}，没有后续内容，请重试。`;

                                        await fetch(`${hostUrl}/api/v1/jsplugin/miot/mina/tts`, {
                                            method: 'POST',
                                            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                                            body: JSON.stringify({
                                                account_id: msg.data.account_id,
                                                device_id: msg.data.device_id,
                                                text: ttsText
                                            })
                                        });
                                    } catch (e) {
                                        pushDebugLog(`⚠️ 空指令 TTS 提示异常: ${e}`);
                                    }
                                })();
                            }
                        }
                    }
                }
            } catch (e) { }
        };

        wsClient.onclose = () => {
            pushDebugLog('⚠️ 小爱对话监听通道已断开，将在 5 秒后自动重连...');
            scheduleReconnect();
        };

        wsClient.onerror = () => {
        };

    } catch (e) {
        pushDebugLog(`❌ 建立 WebSocket 连接异常: ${e}`);
        scheduleReconnect();
    }
}

// === 初始化 ===
async function onInit(): Promise<void> {
    pushDebugLog('🟢 小爱语音助手后端引擎已启动');

    await updateGlobalSettingsCache();
    await rebuildVoiceRoutes();
    pushDebugLog('========================================');

    startServerHostDaemon();
    setupCommSyncListeners();
    connectWebSocket();
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
            await updateGlobalSettingsCache();
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