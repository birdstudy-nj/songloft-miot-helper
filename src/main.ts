/// <reference types="@songloft/plugin-sdk" />
import { jsonResponse, createRouter, parseQuery } from '@songloft/plugin-sdk';
import type { HTTPRequest, HTTPResponse } from '@songloft/plugin-sdk';
import { setupWebDAVRoutes, searchWebDavSongs } from './webdav';
import { searchLxMusicSongs } from './lxmusic';
import { searchMusicFreeSongs, searchMusicFreePlaylists } from './musicfree';
import { searchExpertSongs } from './expert';
import { askLlm, formatNow, normalizeNativeAnswer, fetchModelList, judgeNativeAnswer, QA_DEFAULTS, NATIVE_FAIL_PATTERNS } from './qa';

const router = createRouter();
let wsClient: any = null;
const TWIN_PLUGIN_ID = 'iwebplayer';
let cachedServerHost = '';
let cachedQaConfig: any = null;

// 🔢 问答接管防抢话序号（按设备分片）：连说两句时，旧请求的结果作废
const qaRequestSeq = new Map<string, number>();

// 🗨️ 最近一条小爱原生回答（按设备分片）：既作大模型的参考上下文，也用于判定「小爱答没答上来」。
//    真机实测：它与 query 在同一条 ws 推送里一并到达，所以命中口令时通常已经拿得到。
//    ⚠️ 必须带时间戳：不带的话，上一轮的回答会一直留在表里，被当成这一轮的回答来判定
//    （补位模式下会因此误判「小爱答上来了」而永远不接管）。
const lastNativeAnswer = new Map<string, { text: string; at: number }>();
const NATIVE_ANSWER_TTL_MS = 8000;

function setNativeAnswer(scope: string, text: any) {
    const t = String(text == null ? '' : text).trim();
    if (!t) { lastNativeAnswer.delete(scope); return; } // 这一轮没抓到就清空，绝不留下上一轮的
    lastNativeAnswer.set(scope, { text: t, at: Date.now() });
}

function getNativeAnswer(scope: string): string {
    const hit = lastNativeAnswer.get(scope);
    if (!hit) return '';
    if (Date.now() - hit.at > NATIVE_ANSWER_TTL_MS) return ''; // 过期的上一轮回答，不能拿来判定
    return hit.text;
}

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
    failedSound: 'on',   // 🌟 失败提示音开关 ('on' | 'off')
    emptyCmdTTS: 'on',   // 🌟 空指令语音提示开关 ('on' | 'off')
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
    // ⚠️ 打断窗口也必须一起收手：否则用户刚问完天气、紧接着点一首歌，
    //    窗口还没跑完就会把音乐播放一遍遍掐掉。
    cancelStopBurst(key);
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
    songloft.comm.onMessage("sync_webdav_data", async (payload: any, from: string) => {
        if (from !== TWIN_PLUGIN_ID) return;
        try {
            // 处理 iWebPlayer 发来的删除指令
            if (payload.type === 'delete' && payload.key) {
                const key = payload.key;
                await songloft.storage.delete(key);
                return;
            }

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
}

// 🛑 下发小爱音箱停止播放指令
// ------------------------------------------------------------------
// 两个端点语义不同，都要打：
//   /miot/mina/stop   —— 官方 miot 插件的打断动作走的就是这条（minaService.stopPlay，
//                        打断的是「小爱的语音播报」）；
//   /miot/player/stop —— 音乐播放器的停止（我们此前只打了这条）。
// 真机上哪个端点能压住小爱的原生应答无法离线确定，索性两个并打，
// 任一返回 2xx 即视为打断成功（另一个失败不算整体失败，避免误报）。
async function stopMiotPlayer(accountId: string, deviceId: string, opts?: { quiet?: boolean }): Promise<boolean> {
    const quiet = !!(opts && opts.quiet);

    try {
        const hostUrl = await songloft.plugin.getHostUrl();
        const token = await songloft.plugin.getToken();
        const headers = {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-Fetch-Timeout-Ms': '1500'
        };
        const body = JSON.stringify({ account_id: accountId, device_id: deviceId });
        const paths = [
            '/api/v1/jsplugin/miot/mina/stop',
            '/api/v1/jsplugin/miot/player/stop'
        ];

        let ok = false;
        const results = await Promise.all(paths.map(async (p) => {
            const url = `${hostUrl}${p}?account_id=${accountId}&device_id=${deviceId}`;
            try {
                const res = await fetch(url, { method: 'POST', headers, body });
                if (res.ok) return 'ok';
                return `HTTP ${res.status}`;
            } catch (e) {
                return `异常 ${e}`;
            }
        }));

        results.forEach((r, i) => {
            if (r === 'ok') ok = true;
            else if (!quiet) pushDebugLog(`⚠️ 停止指令 ${paths[i].split('/').slice(-2).join('/')} 未成功: ${r}`);
        });

        if (ok) {
            if (!quiet) pushDebugLog(`🛑 已下发停止指令，终止音箱播放`);
        } else if (!quiet) {
            pushDebugLog(`⚠️ 两个停止端点均未成功，本次未能打断`);
        }
        return ok;
    } catch (e) {
        if (!quiet) pushDebugLog(`⚠️ 执行停止播放异常: ${e}`);
        return false;
    }
}

/** 取整并夹在 [min, max] 内，非法值回落到 def */
function clampInt(v: any, min: number, max: number, def: number): number {
    const n = Math.round(Number(v));
    if (!isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
}

// ==========================================
// 🔇 连续打断窗口（stop burst）
// ------------------------------------------------------------------
// 为什么单发一次不够：
//   小爱原生回答与 query 在**同一条 ws 推送**里一并到达（真机实测），
//   但设备**何时起播**对我们不可见 —— 可能在我们拿到文本帧之前就已开念，
//   也可能还要再等 1~2 秒才起播。单发 stop 若正好落在「还没起播」的空档上，
//   就是一次空转；设备随后照常把原生回答念完，我们的 TTS 再跟上，
//   用户听到的就是「先说一遍小爱的、再说一遍模型的」。
// 做法：
//   命中口令后立刻打一发，之后每 intervalMs 补一发，直到大模型结果就绪才收手。
//   起播时机无论落在窗口内哪一点，都会被窗口里的下一次 stop 打掉。
// ==========================================
interface StopBurst {
    /** 已下发的停止次数 */
    count: number;
    /** 收手（不会再补发） */
    stop: () => void;
}

const stopBursts = new Map<string, StopBurst>();

/** 收掉指定设备的打断窗口（若有）。新交互开始时调用，防止误伤后续播放。 */
function cancelStopBurst(scope: string) {
    const b = stopBursts.get(scope);
    if (b) {
        b.stop();
        stopBursts.delete(scope);
    }
}

function startStopBurst(accountId: string, deviceId: string, scope: string, mySeq: number, intervalMs: number, maxMs: number): StopBurst {
    let stopped = false;
    let timer: any = null;
    const t0 = Date.now();

    const burst: StopBurst = {
        count: 0,
        stop: () => {
            stopped = true;
            if (timer) { clearTimeout(timer); timer = null; }
        }
    };

    const tick = async () => {
        if (stopped) return;
        // 期间用户又提了新问题 → 本窗口作废
        if (qaRequestSeq.get(scope) !== mySeq) { stopped = true; return; }

        burst.count++;
        const tickStart = Date.now();
        await stopMiotPlayer(accountId, deviceId, { quiet: burst.count > 1 }); // 只让第一发打日志

        if (stopped) return;
        if (Date.now() - t0 >= maxMs) { stopped = true; return; }

        // 扣掉本次下发本身的往返耗时（真机约 130ms），让「间隔」是两发之间的真实时间，
        // 而不是「间隔 + 往返」。若单次耗时比间隔还长，就退化为「不重叠地连打」，不会堆积请求。
        const cost = Date.now() - tickStart;
        timer = setTimeout(tick, Math.max(0, intervalMs - cost));
    };

    tick(); // 第一发立即出去
    return burst;
}

// ⚠️ 播放失败提示音 (SongLoft_failed.3a76aaad.mp3) 并挂载 5 秒自动关停
async function playFailedSound(accountId: string, deviceId: string) {
    // 🔇 开关关闭时静默处理（不动定时器，避免打断正在播放的提示音收尾）
    if (cachedGlobalSettings.failedSound === 'off') {
        pushDebugLog(`🔇 失败提示音已关闭，本次静默处理`);
        return;
    }
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

// 🗣️ 专家模式指令回话 (调用成功后的自定义 TTS 播报)
async function speakExpertReply(text: string, accountId: string, deviceId: string) {
    try {
        const hostUrl = await songloft.plugin.getHostUrl();
        const token = await songloft.plugin.getToken();
        pushDebugLog(`📣 [专家模式] 指令回话 TTS: ${text}`);
        const res = await fetch(`${hostUrl}/api/v1/jsplugin/miot/mina/tts`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Fetch-Timeout-Ms': '3000' },
            body: JSON.stringify({ account_id: accountId, device_id: deviceId, text })
        });
        if (!res.ok) pushDebugLog(`⚠️ [专家模式] 指令回话 TTS 下发失败 (HTTP ${res.status})`);
    } catch (e) {
        pushDebugLog(`⚠️ [专家模式] 指令回话 TTS 异常: ${e}`);
    }
}

// ⚙️ 预热全局设置缓存
async function updateGlobalSettingsCache() {    try {
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

// 🧪 专家模式测试调用接口：仅解析并返回结果，不推送到音箱
router.post('/expert/test', async (req) => {
    try {
        const body = req.body ? JSON.parse(typeof req.body === 'string' ? req.body : String.fromCharCode.apply(null, Array.from(req.body as Uint8Array))) : {};
        const cfg = body.config;
        const keyword = typeof body.keyword === 'string' ? body.keyword : '';
        if (!cfg || !cfg.urlTemplate) return jsonResponse({ error: "缺少有效的配置或 URL" }, 400);

        const testLogs: string[] = [];
        const collect = (m: string) => { testLogs.push(m); };

        const started = Date.now();
        const searchRes = await searchExpertSongs(cfg, keyword, cfg.limit || 0, collect, typeof body.deviceId === 'string' ? body.deviceId : '');
        const cost = Date.now() - started;

        // 纯指令调用模式：返回调用结果而非歌曲
        if (searchRes && searchRes.isAction) {
            return jsonResponse({
                ok: !!searchRes.actionOk, cost, logs: testLogs,
                isAction: true,
                actionStatus: searchRes.actionStatus,
                actionSnippet: searchRes.actionSnippet || '',
                actionReply: searchRes.actionReply || ''
            });
        }

        if (!searchRes || searchRes.songs.length === 0) {
            return jsonResponse({ ok: false, cost, logs: testLogs, songs: [], collectionName: '' });
        }

        const previewSongs = searchRes.songs.slice(0, 30).map(s => ({
            title: s.title, artist: s.artist, album: s.album,
            duration: s.duration, cover_url: s.cover_url, url: s.url
        }));

        return jsonResponse({
            ok: true, cost, logs: testLogs,
            total: searchRes.songs.length,
            collectionName: searchRes.collectionName,
            songs: previewSongs
        });
    } catch (e) { return jsonResponse({ ok: false, error: String(e) }, 500); }
});

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

// 🌟 判断某条口令是否允许「无后续关键词」直接执行
//   - 配置了固定关键词：关键词由配置提供，用户无需再补充
//   - 专家模式·纯指令调用(action)：只发一次请求，本就不需要关键词
//   - 专家模式·URL/请求体均不含 {keyword} 占位符：关键词不参与请求
function isKeywordOptional(route: any): boolean {
    if (!route) return false;
    if (route.fixedKeyword) return true;
    if (route.engine === 'expert') {
        const c = route.expertCfg || {};
        if (c.responseType === 'action') return true;
        const tpl = String(c.urlTemplate || '');
        const body = String(c.postBody || '');
        if (!tpl.includes('{keyword}') && !body.includes('{keyword}')) return true;
    }
    return false;
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

    // 🌟 问答接管：关键词只去掉口令词本身，不做平台词 / 动词 / 连词的剥离
    //    （否则“问问怎么用百度搜索”会被误删成“怎么用百度”）
    if (best.engine === 'qa') {
        const qText = textToParse.split(matchedWord).join('').trim();
        return {
            type: 'qa', engine: 'qa', node: 'default',
            quality: undefined, strategy: undefined,
            platform: null, keyword: qText, matchedWord,
            limit: 0,
            shuffleFlag: false,
            keywordOptional: false,
            qaCfg: best.qaCfg
        };
    }

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
        shuffleFlag: finalShuffle, // 🌟 传出最终运算后的乱序标记
        keywordOptional: isKeywordOptional(best), // 🌟 该口令是否允许无后续关键词直接执行
        expertCfg: best.expertCfg
    };
}


// ==========================================
// 🚀 核心：全局意图路由表
// ==========================================
let voiceRoutes: Record<string, { type: string, engine: string, node: string, quality?: string, strategy?: string, limit?: number, shuffle?: boolean, fixedKeyword?: string, expertCfg?: any, qaCfg?: any }> = {};

async function rebuildVoiceRoutes() {
    try {
        voiceRoutes = {};
        const wdRaw = await songloft.storage.get('xiaoai_dav_configs');
        const lxRaw = await songloft.storage.get('xiaoai_lx_configs');
        const mfRaw = await songloft.storage.get('xiaoai_mf_configs');
        const exRaw = await songloft.storage.get('xiaoai_expert_configs');

        let wdConfigs = [];
        let lxConfigs = [];
        let mfConfigs: any[] = [];
        if (!mfRaw || mfRaw === 'null' || mfRaw === '[]') {
            mfConfigs = [
                { engine: 'musicfree', type: 'search', node: 'default', quality: 'standard', strategy: 'first', isDefault: true, cmds: ['在线歌曲'] },
                { engine: 'musicfree', type: 'play', node: 'default', quality: 'standard', strategy: 'first', isDefault: true, cmds: ['在线歌单'] }
            ];
            await safeStorageSet('xiaoai_mf_configs', JSON.stringify(mfConfigs));
        } else {
            try { mfConfigs = typeof mfRaw === 'string' ? JSON.parse(mfRaw) : mfRaw; } catch (e) {}
            if (!Array.isArray(mfConfigs)) mfConfigs = [];
        }

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

        const allConfigs = [...wdConfigs, ...lxConfigs, ...mfConfigs];

        // 🌟 专家模式配置 (纯自定义，不注入任何默认口令)
        let exConfigs: any[] = [];
        if (exRaw && exRaw !== 'null' && exRaw !== '[]') {
            try { exConfigs = typeof exRaw === 'string' ? JSON.parse(exRaw) : exRaw; } catch (e) {}
            if (!Array.isArray(exConfigs)) exConfigs = [];
        }

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

        // 🌟 挂载专家模式自定义口令
        for (const cfg of exConfigs) {
            if (cfg.enabled === false) continue;
            if (Array.isArray(cfg.cmds)) {
                for (const cmd of cfg.cmds) {
                    if (cmd) {
                        voiceRoutes[cmd] = {
                            type: 'expert',
                            engine: 'expert',
                            node: 'default',
                            limit: cfg.limit,
                            shuffle: cfg.shuffle,
                            expertCfg: cfg
                        };
                    }
                }
            }
        }

        // 🌟 挂载问答接管口令 (独立配置：xiaoai_qa_config)
        const qaRaw = await songloft.storage.get('xiaoai_qa_config');
        cachedQaConfig = null;
        if (qaRaw && qaRaw !== 'null') {
            try { cachedQaConfig = typeof qaRaw === 'string' ? JSON.parse(qaRaw) : qaRaw; } catch (e) { cachedQaConfig = null; }
        }
        if (cachedQaConfig && cachedQaConfig.enabled !== false && Array.isArray(cachedQaConfig.cmds)) {
            for (const cmd of cachedQaConfig.cmds) {
                if (cmd) {
                    voiceRoutes[cmd] = { type: 'qa', engine: 'qa', node: 'default', limit: 0, qaCfg: cachedQaConfig };
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
            expectedTtsDelayMs = Math.ceil(totalSyllables / 4.5) * 1000;

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

        } else if (engine === 'webdav' || engine === 'musicfree' || engine === 'expert') {
            const channelName = engine === 'musicfree' ? 'MusicFree' : (engine === 'expert' ? '专家模式' : 'WebDAV');
            pushDebugLog(`🔗 [${channelName}通道] 正在向系统注册 ${songs.length} 首远程歌曲 (${songNames})...`);

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

// ==========================================
// 🔓 自由补位（可选，默认关闭）
// ------------------------------------------------------------------
// 场景：用户没喊「问问/问一下」口令，只是正常跟小爱聊天，结果小爱答不上来
//      （"对不起，我还在学习中"），此时也允许大模型补位。
// 为什么默认关闭：没有口令词就没有"这条指令归我"的边界，
//      一旦开着，普通对话也可能被抢走。只在「小爱明确答不上来」时才接管，
//      正常指令（下一首/暂停/天气…）小爱都有回答 → 判定为答上来了 → 不接管。
// 为什么不与「全接管」模式共存：全接管的语义就是"每条命中口令的都要我的答案"，
//      把它套到所有对话上会变成无条件抢占。
// ==========================================
function tryFreeFallback(query: string, accountId: string, deviceId: string) {
    try {
        const cfg = cachedQaConfig || {};
        if (cfg.enabled === false) return;
        if (!cfg.freeFallback) return;
        if ((cfg.qaMode === 'takeover' ? 'takeover' : 'fallback') !== 'fallback') return;

        const scope = `${accountId}_${deviceId}`;
        const v = judgeNativeAnswer(getNativeAnswer(scope), cfg.fallbackPatterns);
        // 没抓到回答 ≠ 答不上来：小爱可能只是这轮没理（还在处理/别的设备），别抢
        if (v.usable || v.reason === 'empty') return;

        const why = v.reason === 'matched' ? `命中「${v.matched}」` : v.reason;
        pushDebugLog(`🔓 [自由补位] 未喊口令但小爱答不上来（${why}），交给大模型: "${query.slice(0, 40)}"`);

        handleVoiceCommand('qa', 'qa', 'default', query, accountId, deviceId)
            .catch(async () => { await playFailedSound(accountId, deviceId); })
            .finally(() => { pushDebugLog('========================================'); });
    } catch (e) {
        pushDebugLog(`⚠️ 自由补位异常: ${e}`);
    }
}

// 🔔 问答接管的前置提示：确定要调大模型了，先说一声，别让用户以为没听见。
//    ⚠️ 必须与「连续打断窗口」互斥 —— 窗口每 intervalMs 就补一发 stop，
//    会把插件自己刚播出去的提示语掐掉。调用方据此强制走单发打断。
async function playAiHint(accountId: string, deviceId: string, cfg: any, mode: 'off' | 'tts' | 'sound') {
    if (mode === 'off') return;
    try {
        if (mode === 'sound') {
            pushDebugLog(`🔔 [问答] 前置提示音: ${cachedGlobalSettings.hitSound || '（全局未配置）'}（提示期间改用单发打断）`);
            playHitSound(accountId, deviceId);
            return;
        }
        const text = String(cfg.aiHintText || '').trim() || QA_DEFAULTS.aiHintText;
        const hostUrl = await songloft.plugin.getHostUrl();
        const token = await songloft.plugin.getToken();
        const res = await fetch(`${hostUrl}/api/v1/jsplugin/miot/mina/tts`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-Fetch-Timeout-Ms': '5000'
            },
            body: JSON.stringify({ account_id: accountId, device_id: deviceId, text })
        });
        if (res.ok) {
            pushDebugLog(`🔔 [问答] 前置语音提示: "${text}"（提示期间改用单发打断）`);
        } else {
            pushDebugLog(`⚠️ [问答] 前置语音提示下发失败 (HTTP ${res.status})，继续等答案`);
        }
    } catch (e) {
        pushDebugLog(`⚠️ [问答] 前置提示异常: ${e}`);
    }
}

// 🎯 语音口令处理总入口
async function handleVoiceCommand(cmdType: string, engine: string, nodeName: string, rawKeyword: string, accountId: string, deviceId: string, quality?: string, strategy?: string, parsedPlatform?: string | null, shuffleFlag?: boolean, parsedLimit?: number, expertCfg?: any) {
    const doShuffle = !!shuffleFlag;

    // 🔇 任何新口令进来，先收掉上一轮可能还开着的打断窗口：
    //    否则「问完天气马上点歌」时，旧窗口会把刚起的音乐一遍遍掐掉。
    cancelStopBurst(`${accountId}_${deviceId}`);

    // === 问答接管处理分支 ===
    // 链路：命中口令 → 打断小爱 → 缓冲 → 大模型整段生成 → TTS 播报
    if (engine === 'qa') {
        const question = (rawKeyword || '').trim();
        if (!question) {
            pushDebugLog('⚠️ [问答] 未捕获到问题内容');
            await playFailedSound(accountId, deviceId);
            return;
        }

        const qaCfg = cachedQaConfig || {};
        cancelAllTimers(accountId, deviceId);

        // 防抢话：同设备上后来的提问顶替先前的，避免两个回答串台播出
        const scope = `${accountId}_${deviceId}`;
        const mySeq = (qaRequestSeq.get(scope) || 0) + 1;
        qaRequestSeq.set(scope, mySeq);

        // 上一题若还留着打断窗口，先收手再换新的
        cancelStopBurst(scope);

        // ==== 接管时机判定：补位（默认）/ 全接管 ====
        // 为什么要「补位」：真机实测连续下发 4 次停止指令，小爱的原生回答照样念完 ——
        // 设备侧起播时机不可控，我们抢不过它。与其抢，不如只在它答不上来时才让大模型上。
        const qaMode = qaCfg.qaMode === 'takeover' ? 'takeover' : 'fallback';

        let nativeRaw = getNativeAnswer(scope);
        if (qaMode === 'fallback' && !nativeRaw) {
            // 回答通常与 query 同帧到达；万一慢一拍，最多再等这么久再判定（设 0 即不等）
            const waitMs = clampInt(qaCfg.waitNativeMs, 0, 3000, QA_DEFAULTS.waitNativeMs);
            const deadline = Date.now() + waitMs;
            while (waitMs > 0 && Date.now() < deadline && !nativeRaw) {
                await new Promise((r) => setTimeout(r, 100));
                nativeRaw = getNativeAnswer(scope);
            }
        }

        const verdict = qaMode === 'fallback'
            // ⚠️ 这里必须传原始值：parsePatternList 会把 undefined 也变成 []，
            //    而「没配过」(用默认表) 与「显式清空」(永不接管) 是两种语义，不能混。
            ? judgeNativeAnswer(nativeRaw, qaCfg.fallbackPatterns)
            : { usable: false, reason: 'takeover' as const, matched: '' };

        if (verdict.usable) {
            // 小爱答上来了 → 闭嘴。不下发任何 stop、不请求大模型，用户只听到一遍。
            pushDebugLog(`🙊 [问答] 小爱已作答（${nativeRaw.length} 字），本次不接管: ${nativeRaw.slice(0, 40)}`);
            return;
        }

        // 小爱自己的回答作为参考上下文（走到这儿说明它没答上来；
        // 但全接管模式下它可能是答对了的 —— 不带它会出现「掐掉正确的、播出错误的」，
        // 例：问天气，小爱有实时数据答得对，大模型没实时信息就会编，真机已复现）。
        const nativeRef = normalizeNativeAnswer(nativeRaw);

        const startedAt = Date.now();
        const modeTag = qaMode === 'fallback' ? '补位接管' : '全部接管';
        const failTag = verdict.reason === 'matched' ? `｜小爱答不上来: 命中「${verdict.matched}」` : '';
        const refTag = nativeRef ? `｜带原生回答 ${nativeRef.length} 字作参考` : '｜无原生回答可参考';
        pushDebugLog(`🧠 [问答] 命中提问: "${question}"（${modeTag}${failTag}${refTag}）`);

        // 1. 先发大模型请求（不 await），与「打断小爱」并行 —— 省掉串行的 ~400ms
        const llmPromise = askLlm(qaCfg, question, pushDebugLog, { now: formatNow() }, nativeRef)
            .catch((e) => { pushDebugLog(`⚠️ [问答] 引擎异常: ${e}`); return null; });

        // 2. 打断小爱自己的应答。
        //    burst：整个等待大模型的窗口内反复 stop —— 设备何时起播不可控，
        //           单发 stop 可能落在起播前的空档上而空转（详见 startStopBurst 注释）。
        //    once：只打一发。
        //    ⚠️ 开了前置提示就**必须**走 once：提示语是我们自己刚播的 TTS，
        //    窗口的补发 stop 会把它连播到一半掐掉。
        const hintMode = (qaCfg.aiHint === 'tts' || qaCfg.aiHint === 'sound') ? qaCfg.aiHint as 'tts' | 'sound' : 'off';
        const interruptMode = (hintMode !== 'off' || qaCfg.interruptMode === 'once') ? 'once' : 'burst';
        const intervalMs = clampInt(qaCfg.interruptIntervalMs, 150, 3000, 350);
        const llmTimeoutMs = clampInt(qaCfg.timeoutMs, 3000, 60000, 12000);

        let burst: StopBurst | null = null;
        if (interruptMode === 'burst') {
            // 窗口上限取 min(大模型超时, 8s)：跑太久没必要（原生应答在窗口开头就该被打掉了），
            // 而且能缩小「窗口还开着、用户已经转去点歌」时的误伤面。
            const burstMaxMs = Math.min(llmTimeoutMs, 8000);
            burst = startStopBurst(accountId, deviceId, scope, mySeq, intervalMs, burstMaxMs);
            stopBursts.set(scope, burst);
        } else {
            await stopMiotPlayer(accountId, deviceId);
        }

        // 2.5 前置提示：单发 stop 已落地，这里发提示不会被自己的 stop 掐掉。
        //     与大模型请求并行，不额外增加端到端延迟。
        const hintAt = Date.now();
        if (hintMode !== 'off') {
            await playAiHint(accountId, deviceId, qaCfg, hintMode);
        }

        const answer = await llmPromise;

        // 3. 收手：停掉打断窗口，报一下总共打了几发（便于真机调间隔）
        if (burst) {
            burst.stop();
            // ⚠️ 只清理自己的那一份：期间若有新提问进来，它已经在表里放了自己的窗口，
            //    无条件 delete 会把新窗口从表里摘掉，导致后续"收手闸门"再也找不到它。
            if (stopBursts.get(scope) === burst) stopBursts.delete(scope);
            if (burst.count > 1) {
                pushDebugLog(`🔇 [问答] 打断窗口共下发 ${burst.count} 次停止指令（间隔 ${intervalMs}ms）`);
            }
        }

        if (!answer) {
            await playFailedSound(accountId, deviceId);
            return;
        }

        // 若期间用户又提了新问题，本次结果作废，不再抢播
        if (qaRequestSeq.get(scope) !== mySeq) {
            pushDebugLog('🚫 [问答] 本次回答已被更新的提问顶替，放弃播报');
            return;
        }

        // 4. 收尾再播答案 TTS。两种走法：
        //    · 没提示语 → 补一发 stop 清掉可能刚起播的原生回答 + 300ms 缓冲（两者并行）；
        //    · 有提示语 → **绝不能再下发 stop**（会把自己的提示掐掉），
        //      改为等提示语播满 aiHintHoldMs 再送答案；大模型比提示语还快时也至少留 300ms。
        if (hintMode !== 'off') {
            const holdMs = clampInt(qaCfg.aiHintHoldMs, 500, 6000, QA_DEFAULTS.aiHintHoldMs);
            const waitMs = Math.max(300, hintAt + holdMs - Date.now());
            await new Promise((r) => setTimeout(r, waitMs));
        } else {
            // 打断窗口的最后一发可能已经过去 intervalMs，期间起播的原生回答要靠这一发打掉；
            // 300ms 缓冲是官方 miot 插件同款做法，规避“打断后立即播 TTS 被吞”。
            await Promise.all([
                stopMiotPlayer(accountId, deviceId, { quiet: true }),
                new Promise((r) => setTimeout(r, 300))
            ]);
        }

        // 5. TTS 播报回答
        try {
            const hostUrl = await songloft.plugin.getHostUrl();
            const token = await songloft.plugin.getToken();
            pushDebugLog(`📣 [问答] 播报回答: ${answer}`);

            const res = await fetch(`${hostUrl}/api/v1/jsplugin/miot/mina/tts`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'X-Fetch-Timeout-Ms': '5000'
                },
                body: JSON.stringify({ account_id: accountId, device_id: deviceId, text: answer })
            });

            if (!res.ok) {
                pushDebugLog(`⚠️ [问答] TTS 下发失败 (HTTP ${res.status})`);
                await playFailedSound(accountId, deviceId);
            } else {
                pushDebugLog(`✅ [问答] 回答已下发（${answer.length} 字，端到端 ${Date.now() - startedAt}ms）`);
            }
        } catch (e) {
            pushDebugLog(`⚠️ [问答] TTS 异常: ${e}`);
            await playFailedSound(accountId, deviceId);
        }
        return;
    }

    // === 专家模式处理分支 ===
    if (engine === 'expert') {
        let effectiveLimit = (parsedLimit && parsedLimit > 0) ? parsedLimit : (cachedGlobalSettings.defaultLimit || 500);
        try {
            const searchRes = await searchExpertSongs(expertCfg, rawKeyword, effectiveLimit, pushDebugLog, deviceId);

            // 纯指令调用模式：只发请求 + 可选 TTS 回话，不播放音乐
            if (searchRes && searchRes.isAction) {
                if (searchRes.actionOk) {
                    cancelAllTimers(accountId, deviceId);
                    if (searchRes.actionReply && searchRes.actionReply.trim()) {
                        await speakExpertReply(searchRes.actionReply.trim(), accountId, deviceId);
                    }
                } else {
                    await playFailedSound(accountId, deviceId);
                }
                return;
            }

            if (searchRes === null || searchRes.songs.length === 0) {
                await playFailedSound(accountId, deviceId);
            } else {
                const songs = searchRes.songs;
                const collectionName = searchRes.collectionName;

                let finalSongs = doShuffle && songs.length > 1 ? songs.slice().sort(() => Math.random() - 0.5) : songs;
                if (doShuffle && songs.length > 1) pushDebugLog(`🎲 已开启随机播放，打乱 ${songs.length} 首歌曲顺序`);

                if (finalSongs.length > effectiveLimit) {
                    pushDebugLog(`✂️ 触发数量限制: 已截取前 ${effectiveLimit} 首歌曲`);
                    finalSongs = finalSongs.slice(0, effectiveLimit);
                }

                await createPushPlaylistAndPlay(finalSongs, accountId, deviceId, 'expert', collectionName);
            }
        } catch (e) {
            pushDebugLog(`⚠️ 专家模式执行异常: ${e}`);
            await playFailedSound(accountId, deviceId);
        }
        return;
    }

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

    // === MusicFree 处理分支 ===
    if (engine === 'musicfree') {
        let actualPlatform = nodeName;
        let actualQuality = quality || 'standard';
        let actualStrategy = strategy || 'first';
        let effectiveLimit = (parsedLimit && parsedLimit > 0) ? parsedLimit : (cachedGlobalSettings.defaultLimit || 500);

        if (nodeName === 'default') {
            try {
                const cfgRaw = await songloft.storage.get('musicfree_config');
                const cfg = typeof cfgRaw === 'string' ? JSON.parse(cfgRaw) : (cfgRaw || {});
                const settings = cfg.settings || {};

                actualPlatform = String(settings.default_platform || 'default');
                actualQuality = String(settings.default_quality || 'standard');
                actualStrategy = String(settings.default_strategy || 'first');

                pushDebugLog(`⚙️ MF触发全局默认策略: 源[${actualPlatform}], 音质[${actualQuality}], 策略[${actualStrategy}]`);
            } catch (e) {
                actualPlatform = 'default';
                actualQuality = 'standard';
                actualStrategy = 'first';
            }
        }

        try {
            let searchRes: { songs: any[], collectionName: string } | null = null;

            if (cmdType === 'search') {
                // 搜单曲
                const songs = await searchMusicFreeSongs(actualPlatform, rawKeyword, actualQuality, effectiveLimit, pushDebugLog);
                if (songs && songs.length > 0) {
                    searchRes = { songs: songs, collectionName: "" };
                }
            } else if (cmdType === 'play') {
                // 搜歌单
                searchRes = await searchMusicFreePlaylists(actualPlatform, rawKeyword, actualQuality, actualStrategy, effectiveLimit, pushDebugLog);
            } else {
                pushDebugLog(`⚠️ MusicFree 尚不支持指令类型 [${cmdType}]，已中断`);
                await playFailedSound(accountId, deviceId);
                return;
            }

            if (searchRes === null || searchRes.songs.length === 0) {
                pushDebugLog(`💀 未在 MusicFree 搜到关于 "${rawKeyword}" 的音乐，放弃操作`);
                await playFailedSound(accountId, deviceId);
            } else {
                const songs = searchRes.songs;
                const collectionName = searchRes.collectionName;

                pushDebugLog(`🎉 MusicFree 成功集结 ${songs.length} 首歌曲！`);
                let finalSongs = doShuffle && songs.length > 1 ? songs.slice().sort(() => Math.random() - 0.5) : songs;
                if (doShuffle && songs.length > 1) pushDebugLog(`🎲 已开启随机播放，打乱 ${songs.length} 首歌曲顺序`);

                // 送入大管家推流
                await createPushPlaylistAndPlay(finalSongs, accountId, deviceId, 'musicfree', collectionName);
            }
        } catch (e) {
            pushDebugLog(`⚠️ MusicFree 执行异常: ${e}`);
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
            pushDebugLog('🔗 小爱对话监听通道已成功连接 (正常待命中)！');
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
        };

        wsClient.onmessage = (event: any) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'message' && msg.data) {
                    // 🌟 小爱自己的回答本来就在推送里（扁平结构 answer / 旧嵌套 response.answer[0].content），
                    //    此前只读了 query 未用它。记录进诊断日志，便于后续做“按小爱回答质量决定是否接管”。
                    const xiaoaiAnswer = msg.data.answer
                        || (msg.data.message?.response?.answer?.[0]?.content);
                    if (xiaoaiAnswer && typeof xiaoaiAnswer === 'string' && xiaoaiAnswer.trim()) {
                        // 缓存起来：① 作为大模型的参考上下文 ② 用于判定「这一轮小爱答没答上来」
                        setNativeAnswer(`${msg.data.account_id}_${msg.data.device_id}`, xiaoaiAnswer);
                        pushDebugLog(`🗨️ 小爱原生回答: ${xiaoaiAnswer.trim().slice(0, 80)}`);
                    } else {
                        // 本轮没有回答 → 必须清空，否则补位模式会拿上一轮的回答当成本轮判定依据
                        setNativeAnswer(`${msg.data.account_id}_${msg.data.device_id}`, '');
                    }

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
                            // 🌟 允许执行的两种情形：
                            //   一、有关键词（常规搜歌）
                            //   二、该口令本身不需要关键词（固定关键词 / 专家模式纯指令调用）
                            if (parsed.keyword || parsed.keywordOptional) {
                                const platDesc = parsed.platform ? ` 平台词: [${PLAT_MAP[parsed.platform] || parsed.platform}]` : '';
                                if (parsed.keyword) {
                                    pushDebugLog(`🎯 命中口令词: [${parsed.matchedWord}], 完整指令: "${trimmedText}"${platDesc}`);
                                } else {
                                    pushDebugLog(`🎯 命中口令词: [${parsed.matchedWord}]，该指令无需后续关键词，直接执行${platDesc}`);
                                }
                                // 🌟 问答接管不播前置提示音：避免与后续 TTS 抢播放通道
                                if (parsed.engine !== 'qa') {
                                    playHitSound(msg.data.account_id, msg.data.device_id);
                                }

                                // 传入解析好的参数
                                handleVoiceCommand(parsed.type, parsed.engine, parsed.node, parsed.keyword, msg.data.account_id, msg.data.device_id, parsed.quality, parsed.strategy, parsed.platform, parsed.shuffleFlag, parsed.limit, parsed.expertCfg)
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

                                // 🔇 独立开关关闭时，只记日志不出声
                                if (cachedGlobalSettings.emptyCmdTTS === 'off') {
                                    pushDebugLog(`🔇 空指令语音提示已关闭，本次静默处理`);
                                    return;
                                }

                                // 启动一个异步闭包发送 TTS 语音，不阻塞 WebSocket 主线程
                                (async () => {
                                    try {
                                        const hostUrl = await songloft.plugin.getHostUrl();
                                        const token = await songloft.plugin.getToken();
                                        const ttsText = parsed.engine === 'qa'
                                            ? `请问你想问什么？`
                                            : `语音助手只听到，${parsed.matchedWord}，没有后续内容，请重试。`;

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
                        } else if (xiaoaiAnswer) {
                            // ⚪ 没命中任何口令 —— 以前这里一声不吭，用户只看到"模型没被调用"，
                            //    完全猜不出原因。小爱有回答时才记（那种情况用户才会关心）。
                            const ans = String(xiaoaiAnswer).trim();
                            pushDebugLog(`⚪ 未命中任何口令（不接管）: "${trimmedText.slice(0, 40)}" ｜ 小爱答: ${ans.slice(0, 24)}`);
                            tryFreeFallback(trimmedText, msg.data.account_id, msg.data.device_id);
                        }
                    } else if (xiaoaiAnswer) {
                        // 这一帧只有回答、没有指令文本 → 无法路由，但必须说清楚，否则日志看起来像"卡住了"
                        pushDebugLog(`⚠️ 收到原生回答但本帧没有指令文本，无法路由: ${String(xiaoaiAnswer).trim().slice(0, 40)}`);
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

        if (key === 'xiaoai_dav_configs' || key === 'xiaoai_lx_configs' || key === 'xiaoai_mf_configs' || key === 'xiaoai_expert_configs' || key === 'xiaoai_qa_config') rebuildVoiceRoutes();

        let syncKey = key;
        if (key === 'webdav_config') syncKey = 'iwebplayer.webdav';

        if (key === 'webdav_config' || key === 'xiaoai_dav_configs' || key === 'xiaoai_lx_configs' || key === 'xiaoai_mf_configs' || key === 'lxmusic_source_urls' || key.startsWith('webdav_lib_')) {
            songloft.comm.send(TWIN_PLUGIN_ID, "sync_webdav_data", { type: 'config', key: syncKey, value: value }).catch(()=>{});
        }
        return jsonResponse({ ret: "OK" });
    } catch (e) { return jsonResponse({ error: String(e) }, 500); }
});

// 真正的物理删除接口 (供前端调用)
router.delete('/store', async (req) => {
    try {
        // 🌟 修复 1：使用官方内置的 parseQuery，避免变成 [object Object]
        const q = parseQuery(req.query);
        const key = q.key as string;

        if (!key) return jsonResponse({ error: "Missing key" }, 400);

        // 执行物理删除
        await songloft.storage.delete(key);

        // 删除成功后，广播告诉 iWebPlayer 也执行删除
        songloft.comm.send(TWIN_PLUGIN_ID, "sync_webdav_data", { type: 'delete', key: key }).catch(()=>{});

        return jsonResponse({ ret: "OK" });
    } catch (error) {
        return jsonResponse({ error: "删除配置失败: " + String(error) }, 500);
    }
});

// 🧠 问答接管：拉取可用模型列表（前端「获取模型」按钮调用，不落盘）
// 由 chat/completions 地址推导 /models，省得用户手敲模型名。
router.post('/qa/models', async (req) => {
    try {
        const body = req.body ? JSON.parse(typeof req.body === 'string' ? req.body : String.fromCharCode.apply(null, Array.from(req.body as Uint8Array))) : {};
        const r = await fetchModelList(String(body.apiUrl || ''), String(body.apiKey || ''), pushDebugLog);
        return jsonResponse(r);
    } catch (e) {
        return jsonResponse({ ok: false, error: String(e), models: [] }, 500);
    }
});

// 🧠 问答接管：连通性自检（前端“测试连接”按钮调用，不落盘、不影响线上配置）
router.post('/qa/test', async (req) => {
    try {
        const body = req.body ? JSON.parse(typeof req.body === 'string' ? req.body : String.fromCharCode.apply(null, Array.from(req.body as Uint8Array))) : {};
        const question = String(body.question || '你好，用一句话打个招呼');

        const logs: string[] = [];
        const answer = await askLlm(body, question, (m) => { logs.push(m); pushDebugLog(m); });

        return jsonResponse({ ok: !!answer, answer: answer || '', logs });
    } catch (e) {
        return jsonResponse({ ok: false, error: String(e), logs: [] }, 500);
    }
});

// 🧠 问答接管：把后端的默认词表与默认值下发给前端（预填表单 / 「恢复默认」按钮用）
//    放在后端是为了只有一份事实来源，避免前端再抄一份导致两边漂移。
router.get('/qa/defaults', async () => {
    return jsonResponse({
        ok: true,
        patterns: NATIVE_FAIL_PATTERNS,
        waitNativeMs: QA_DEFAULTS.waitNativeMs
    });
});

// 🧠 问答接管：试判一句「小爱的原生回答」算不算答上来了（不落盘、不调大模型）
// 用途：在真机上拿真实回答调特征词表 —— 不用每次都对着音箱喊一遍。
router.post('/qa/judge', async (req) => {
    try {
        const body = req.body ? JSON.parse(typeof req.body === 'string' ? req.body : String.fromCharCode.apply(null, Array.from(req.body as Uint8Array))) : {};
        const v = judgeNativeAnswer(String(body.answer || ''), body.patterns);
        return jsonResponse({ ok: true, ...v });
    } catch (e) {
        return jsonResponse({ ok: false, usable: false, reason: 'empty', matched: '', error: String(e) }, 500);
    }
});

setupWebDAVRoutes(router);

// @ts-expect-error
globalThis.onInit = onInit;
// @ts-expect-error
globalThis.onDeinit = onDeinit;
// @ts-expect-error
globalThis.onHTTPRequest = onHTTPRequest;