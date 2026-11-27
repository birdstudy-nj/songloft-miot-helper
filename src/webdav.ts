// src/webdav.ts
import { jsonResponse } from '@songloft/plugin-sdk';
import type { HTTPRequest } from '@songloft/plugin-sdk';

let currentScanVersion = 0;
let scanStatus = 'idle'; // 'idle' | 'scanning' | 'completed' | 'failed'
let scannedFoldersCount = 0;
let activeDavId = '';
let daemonStarted = false; // 守护进程是否已启动
let isWebDavScanning = false; // 软锁防并发

const AUDIO_EXTS = ['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.ape', '.wma', '.alac'];

function isAudioFile(filename: string): boolean {
    const lower = filename.toLowerCase();
    return AUDIO_EXTS.some(ext => lower.endsWith(ext));
}

const TWIN_PLUGIN_ID = 'iwebplayer';

// 安全读写库助手
async function safeStorageSet(key: string, val: string) {
    if (typeof songloft.storage.set === 'function') {
        await songloft.storage.set(key, val);
    } else if (typeof (songloft.storage as any).setItem === 'function') {
        await (songloft.storage as any).setItem(key, val);
    }
}

async function safeStorageGet(key: string) {
    if (typeof songloft.storage.get === 'function') {
        return await songloft.storage.get(key);
    } else if (typeof (songloft.storage as any).getItem === 'function') {
        return await (songloft.storage as any).getItem(key);
    }
    return null;
}

// 🌟 UTF-8 请求体安全解析器（防止中文节点名与文件夹名乱码）
function parseRequestBody(req: HTTPRequest): any {
    if (!req.body) return {};
    try {
        if (typeof req.body === 'string') return JSON.parse(req.body);
        const bytes = req.body as Uint8Array;
        const TD = (globalThis as any).TextDecoder;
        if (TD) return JSON.parse(new TD('utf-8').decode(bytes));

        let out = '', i = 0;
        const len = bytes.length;
        while (i < len) {
            const c = bytes[i++];
            if (c < 0x80) out += String.fromCharCode(c);
            else if (c < 0xE0) out += String.fromCharCode(((c & 0x1F) << 6) | (bytes[i++] & 0x3F));
            else if (c < 0xF0) out += String.fromCharCode(((c & 0x0F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F));
            else {
                const u = (((c & 0x07) << 18) | ((bytes[i++] & 0x3F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F)) - 0x10000;
                out += String.fromCharCode(0xD800 + (u >> 10), 0xDC00 + (u & 0x3FF));
            }
        }
        return JSON.parse(out);
    } catch (e) {
        return {};
    }
}

// 🌟 格式化时间助手: 强制 YYYY-MM-DD HH:mm:ss (24小时制)
function getFormattedTime(): string {
    const d = new Date();
    const yyyy = d.getFullYear();
    const MM = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const HH = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${yyyy}-${MM}-${dd} ${HH}:${mm}:${ss}`;
}

// 🌟 WebDAV 文件夹歌曲通用排序器 (与 iWebPlayer 保持完全一致)
function sortDavSongs(songs: any[], rule?: { type?: string; order?: string }) {
    if (!Array.isArray(songs) || songs.length <= 1 || !rule || !rule.type || rule.type === 'random') return;
    const { type, order = 'asc' } = rule;

    const cleanArtist = (v: any): string => {
        const s = v ? String(v).trim() : '';
        return (s === '未知歌手' || s === '未知') ? '' : s;
    };
    const getFileName = (idVal: any): string => {
        if (!idVal) return '';
        const str = String(idVal).trim();
        if (!str || str.startsWith('dav_temp_')) return '';
        return str.split('/').pop() || '';
    };
    const compareStr = (a: string, b: string): number => {
        try { return a.localeCompare(b, 'zh-CN'); }
        catch (e) { return a.localeCompare(b); }
    };

    songs.sort((a, b) => {
        let valA = '', valB = '';
        if (type === 'name') {
            valA = getFileName(a.id);
            valB = getFileName(b.id);
        } else if (type === 'song') {
            valA = a.title ? String(a.title).trim() : '';
            valB = b.title ? String(b.title).trim() : '';
        } else if (type === 'artist') {
            valA = cleanArtist(a.artist);
            valB = cleanArtist(b.artist);
        } else {
            return 0;
        }

        // 缺失项（含“未知歌手”）统一沉底
        if (!valA && valB) return 1;
        if (valA && !valB) return -1;
        if (!valA && !valB) return 0;

        return order === 'asc' ? compareStr(valA, valB) : compareStr(valB, valA);
    });
}

// 🌐 异步递归扫描核心 (手动与自动共用)
async function runScanTask(version: number, hostUrl: string, token: string, davId: string, rootPath: string) {
    const queue: string[] = [rootPath];
    const resultLibrary: Record<string, any[]> = {};
    let lastWriteTime = Date.now();

    // 🌟 1. 扫描前先读取旧曲库中的 sorts 排序记录 (含 iWebPlayer 推送过来的排序规则)
    let savedSorts: Record<string, { type: string; order: string }> = {};
    try {
        const oldCacheRaw = await safeStorageGet(`webdav_lib_${davId}`);
        if (oldCacheRaw) {
            const oldCache = typeof oldCacheRaw === 'string' ? JSON.parse(oldCacheRaw) : oldCacheRaw;
            if (oldCache && oldCache.sorts && typeof oldCache.sorts === 'object') {
                savedSorts = oldCache.sorts;
            }
        }
    } catch (e) {}

    try {
        while (queue.length > 0) {
            // 互斥锁检测
            if (currentScanVersion !== version) return;

            const currentPath = queue.shift()!;
            const apiUrl = `${hostUrl}/api/v1/jsplugin/dav/lists/${encodeURIComponent(davId)}/items?path=${encodeURIComponent(currentPath)}`;

            try {
                const res = await fetch(apiUrl, { headers: { 'Authorization': `Bearer ${token}` }});
                if (!res.ok) continue;

                const items = await res.json();
                if (!Array.isArray(items)) continue;

                const audioItems = [];

                for (const item of items) {
                    // 🌟 智能兜底：如果 name 为空，就强行从 id（完整路径）中提取最后一段作为真实名字
                    const itemName = item.name || (item.id ? item.id.split('/').filter(Boolean).pop() : '') || '未知项';

                    if (item.type === 'directory') {
                        // 🌟 优先直接使用 id 作为下一次请求的绝对路径，如果没有 id 再自己拼接
                        const nextPath = item.id || (currentPath === '/' ? '/' + itemName : `${currentPath}/${itemName}`);
                        queue.push(nextPath);
                    } else if (item.type === 'file' && isAudioFile(itemName)) {
                        audioItems.push({
                            id: item.id || `dav_temp_${Date.now()}_${Math.random()}`,
                            // 🌟 强制使用提取出来的 itemName 作为歌曲标题，并剥离后缀
                            title: itemName.replace(/\.[^/.]+$/, ""),
                            artist: "未知歌手",
                            album: "",
                            duration: item.duration || 0,
                            cover_url: "",
                            plugin_entry_path: "dav",
                            source_data: JSON.stringify({ configName: davId, path: item.id }),
                            dedup_key: `dav_${davId}_${item.id}`,
                            streamUrl: item.streamUrl,
                            _isOnlineObj: true
                        });
                    }
                }

                if (audioItems.length > 0) {
                    let plName = currentPath === '/' ? '根目录' : currentPath.split('/').pop() || '未知文件夹';
                    // 🌟 2. 若该文件夹有历史排序记录，当场按记录排好序
                    if (savedSorts[plName]) {
                        sortDavSongs(audioItems, savedSorts[plName]);
                    }
                    resultLibrary[plName] = audioItems;
                    scannedFoldersCount++;
                }

                // ⏱️ 3秒心跳批处理写入：保留完整结构与 sorts，避免中途中断冲丢排序记录
                if (Date.now() - lastWriteTime > 3000) {
                    let totalSongs = 0;
                    for (const list of Object.values(resultLibrary)) totalSongs += list.length;

                    const partialLib = {
                        folders: Object.keys(resultLibrary).length,
                        songs: totalSongs,
                        time: getFormattedTime().slice(0, 16),
                        sorts: savedSorts,
                        library: resultLibrary
                    };
                    await safeStorageSet(`webdav_lib_${davId}`, JSON.stringify(partialLib));
                    lastWriteTime = Date.now();
                }
            } catch (err) { songloft.log.error(`[WebDAV] 扫描出错 ${currentPath}: ` + String(err)); }
        }

        // ==========================================
        // 🌟 扫描结束：清理已删目录排序、更新统计并广播
        // ==========================================
        if (currentScanVersion === version) {
            let totalSongs = 0;
            const folders = Object.keys(resultLibrary);
            const cleanedSorts: Record<string, { type: string; order: string }> = {};

            for (const folder of folders) {
                if (savedSorts[folder]) {
                    cleanedSorts[folder] = savedSorts[folder];
                    sortDavSongs(resultLibrary[folder], cleanedSorts[folder]);
                }
                totalSongs += resultLibrary[folder].length;
            }

            const compositeLib = {
                folders: folders.length,
                songs: totalSongs,
                time: getFormattedTime().slice(0, 16),
                sorts: cleanedSorts,
                library: resultLibrary
            };

            const libraryJson = JSON.stringify(compositeLib);

            // 1. 本地落盘保存
            await safeStorageSet(`webdav_lib_${davId}`, libraryJson);

            try {
                // 2. 发送独立曲库更新给 iWebPlayer
                await songloft.comm.send(TWIN_PLUGIN_ID, "sync_webdav_data", {
                    type: 'config',
                    key: `webdav_lib_${davId}`,
                    value: libraryJson
                });
            } catch (e) {}

            scanStatus = 'completed';
            songloft.log.info(`[WebDAV] 节点 [${davId}] 全库扫描已完成并同步！`);
        }
    } catch (fatalErr) {
        if (currentScanVersion === version) scanStatus = 'failed';
    }
}

// ==========================================
// 🤖 极简版：静默后台定时扫描引擎 (附着于 webdav_config)
// ==========================================
async function checkAutoScanDaemon() {
    if (isWebDavScanning || scanStatus === 'scanning') return;

    try {
        const token = await songloft.plugin.getToken();
        const hostUrl = await songloft.plugin.getHostUrl();

        const res = await fetch(`${hostUrl}/api/v1/jsplugin/dav/lists`, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!res.ok) return;

        const servers = await res.json();
        if (!Array.isArray(servers)) return;

        // 统一读取整块大配置
        const configStr = await safeStorageGet('webdav_config');
        let config: any = { settings: {}, roots: {} };
        if (configStr) {
            try { config = typeof configStr === 'string' ? JSON.parse(configStr) : configStr; } catch (e) {}
        }
        if (!config.settings) config.settings = {};

        let isConfigChanged = false; // 标记是否需要保存

        for (const srv of servers) {
            if (isWebDavScanning) break;
            const davId = srv.name;

            const intervalStr = config.settings[`auto_scan_interval_${davId}`] || '0';
            const intervalHours = parseInt(intervalStr, 10);

            if (intervalHours > 0) {
                // 直接从 settings 里读取起跑时间
                const lastScanStr = config.settings[`last_scan_time_${davId}`] || '0';
                let lastScanMs = parseInt(String(lastScanStr), 10);

                const now = Date.now();
                const targetIntervalMs = intervalHours * 60 * 60 * 1000;

                if (now - lastScanMs >= targetIntervalMs) {
                    songloft.log.info(`[WebDAV] 触发自动静默扫描: [${davId}]`);

                    // 1. 更新大 JSON 里的时间戳，并打上变动标记
                    config.settings[`last_scan_time_${davId}`] = now.toString();
                    isConfigChanged = true;

                    const rootPath = (config.roots && config.roots[davId]) ? config.roots[davId] : '/';

                    isWebDavScanning = true;
                    scanStatus = 'scanning';
                    currentScanVersion++;
                    activeDavId = davId;
                    scannedFoldersCount = 0;

                    // 异步调用底层扫库
                    runScanTask(currentScanVersion, hostUrl, token, davId, rootPath).finally(() => {
                        isWebDavScanning = false;
                    });
                }
            }
        }

        // 🌟 软锁保存与广播
        if (isConfigChanged) {
            const updatedConfigStr = JSON.stringify(config);
            await safeStorageSet('webdav_config', updatedConfigStr);
            try {
                await songloft.comm.send(TWIN_PLUGIN_ID, "sync_webdav_data", {
                    type: 'config',
                    key: 'iwebplayer.webdav',
                    value: updatedConfigStr
                });
            } catch(e) {}
        }
    } catch (e) {
        songloft.log.error('[WebDAV] 定时扫描守护进程异常: ' + String(e));
    }
}

// 暴露守护进程的启动器（供 main.ts 的 onInit 中调用）
export function startWebDavAutoScanDaemon() {
    setTimeout(() => {
        checkAutoScanDaemon().catch(() => {});
        setInterval(() => {
            checkAutoScanDaemon().catch(() => {});
        }, 5 * 60 * 1000);
    }, 30 * 1000);
}

// ==========================================
// 🔍 专属 WebDAV 搜歌函数 (含 500 首防爆限制)
// ==========================================
export async function searchWebDavSongs(nodeName: string, keyword: string, logFn: (msg: string) => void): Promise<any[] | null> {
    try {
        let realNode = nodeName;
        if (nodeName === 'default') {
            try {
                const cfgRaw = await safeStorageGet('webdav_config');
                if (cfgRaw) {
                    const cfg = typeof cfgRaw === 'string' ? JSON.parse(cfgRaw) : cfgRaw;
                    realNode = cfg?.settings?.default_server || '';
                    if (!realNode && cfg?.roots) {
                        const availableNodes = Object.keys(cfg.roots);
                        if (availableNodes.length > 0) realNode = availableNodes[0];
                    }
                }
            } catch (e) { realNode = ''; }
        }

        if (!realNode) {
            logFn('❌ 无法搜索：未找到有效的 WebDAV 节点');
            return null;
        }

        const libRaw = await safeStorageGet(`webdav_lib_${realNode}`);

        if (!libRaw) {
            logFn(`⚠️ WebDAV 节点 [${realNode}] 尚未建立曲库索引，请前往面板点击【建立全库索引】！`);
            return null;
        }

        const libData = typeof libRaw === 'string' ? JSON.parse(libRaw) : libRaw;
        const library = libData.library || {};

        if (Object.keys(library).length === 0) {
            logFn(`⚠️ WebDAV 节点 [${realNode}] 曲库数据为空，请前往面板检查路径并重新扫描！`);
            return null;
        }

        const matchedSongs: any[] = [];
        const lowerKeyword = keyword.toLowerCase();

        for (const folder in library) {
            const songs = library[folder];
            if (Array.isArray(songs)) {
                for (const song of songs) {
                    if (song.title && song.title.toLowerCase().includes(lowerKeyword)) {
                        matchedSongs.push(song);
                        if (matchedSongs.length >= 500) {
                            logFn(`⚠️ 搜索结果触达 500 首上限，已熔断防爆`);
                            return matchedSongs;
                        }
                    }
                }
            }
        }

        logFn(`🔍 [WebDAV] 在节点 [${realNode}] 匹配到 [${matchedSongs.length}] 首包含 "${keyword}" 的歌曲`);
        return matchedSongs;
    } catch (e) {
        logFn(`❌ [WebDAV] 搜歌发生异常: ` + String(e));
        return null;
    }
}

// 🔌 挂载路由与守护进程启动
export function setupWebDAVRoutes(router: any) {
    // 启动守护进程 (单例锁)
    if (!daemonStarted) {
        daemonStarted = true;
        startWebDavAutoScanDaemon();
        songloft.log.info('[WebDAV] 自动定时扫描守护进程已启动');
    }

    router.post('/dav/scan', async (req: HTTPRequest) => {
        const data = parseRequestBody(req);
        const davId = data.davId;
        const rootPath = data.rootPath;
        if (!davId || !rootPath) return jsonResponse({ error: "Missing parameters" }, 400);

        const hostUrl = await songloft.plugin.getHostUrl();
        const token = await songloft.plugin.getToken();

        currentScanVersion++;
        activeDavId = davId;
        scanStatus = 'scanning';
        isWebDavScanning = true;
        scannedFoldersCount = 0;

        // ====== 🌟 手动扫库同步更新 last_scan_time 并广播给 iWebPlayer ======
        try {
            const now = Date.now();
            const configStr = await safeStorageGet('webdav_config');
            let config: any = { settings: {}, roots: {} };
            if (configStr) {
                try {
                    const parsed = typeof configStr === 'string' ? JSON.parse(configStr) : configStr;
                    if (parsed && parsed.settings) config.settings = parsed.settings;
                    if (parsed && parsed.roots) config.roots = parsed.roots;
                } catch (e) {}
            }
            config.settings[`last_scan_time_${davId}`] = now.toString();
            const updatedConfigStr = JSON.stringify(config);

            await safeStorageSet('webdav_config', updatedConfigStr);
            await songloft.comm.send(TWIN_PLUGIN_ID, "sync_webdav_data", {
                type: 'config',
                key: 'iwebplayer.webdav',
                value: updatedConfigStr
            });
        } catch (e) {}
        // ================================================================

        runScanTask(currentScanVersion, hostUrl, token, davId, rootPath)
            .catch(() => {})
            .finally(() => { isWebDavScanning = false; });

        return jsonResponse({ status: "scanning", version: currentScanVersion });
    });

    router.get('/dav/status', async (req: HTTPRequest) => {
        return jsonResponse({ status: scanStatus, scanned_folders: scannedFoldersCount, davId: activeDavId });
    });

    router.get('/dav/library', async (req: HTTPRequest) => {
        let davId = '';
        if (req.query) {
            const match = String(req.query).match(/(?:^|&)davId=([^&]*)/);
            if (match) davId = decodeURIComponent(match[1]);
        }
        if (!davId) return jsonResponse({ error: "Missing davId" }, 400);
        const cache = await safeStorageGet(`webdav_lib_${davId}`);
        return jsonResponse(cache ? (typeof cache === 'string' ? JSON.parse(cache) : cache) : {});
    });
}