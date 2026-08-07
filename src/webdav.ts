// src/webdav.ts
import { jsonResponse } from '@songloft/plugin-sdk';
import type { HTTPRequest } from '@songloft/plugin-sdk';

let currentScanVersion = 0;
let scanStatus = 'idle'; // 'idle' | 'scanning' | 'completed' | 'failed'
let scannedFoldersCount = 0;
let activeDavId = '';
let daemonStarted = false; // 守护进程是否已启动

const AUDIO_EXTS = ['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.ape', '.wma', '.alac'];

function isAudioFile(filename: string): boolean {
    const lower = filename.toLowerCase();
    return AUDIO_EXTS.some(ext => lower.endsWith(ext));
}

const TWIN_PLUGIN_ID = 'iwebplayer';

// 安全写库助手
async function safeStorageSet(key: string, val: string) {
    if (typeof songloft.storage.set === 'function') {
        await songloft.storage.set(key, val);
    } else if (typeof (songloft.storage as any).setItem === 'function') {
        await (songloft.storage as any).setItem(key, val);
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

// 🌐 异步递归扫描核心 (手动与自动共用)
async function runScanTask(version: number, hostUrl: string, token: string, davId: string, rootPath: string) {
    const queue: string[] = [rootPath];
    const resultLibrary: Record<string, any[]> = {};
    let lastWriteTime = Date.now();

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
                    if (item.type === 'directory') {
                        const nextPath = currentPath === '/' ? '/' + item.name : `${currentPath}/${item.name}`;
                        queue.push(nextPath);
                    } else if (item.type === 'file' && isAudioFile(item.name)) {
                        audioItems.push({
                            id: item.id || `dav_temp_${Date.now()}_${Math.random()}`,
                            title: item.name.replace(/\.[^/.]+$/, ""),
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
                    resultLibrary[plName] = audioItems;
                    scannedFoldersCount++;
                }

                // 心跳写入
                if (Date.now() - lastWriteTime > 3000) {
                    await safeStorageSet(`webdav_lib_${davId}`, JSON.stringify(resultLibrary));
                    lastWriteTime = Date.now();
                }
            } catch (err) { songloft.log.error(`[WebDAV] 扫描出错 ${currentPath}: ` + String(err)); }
        }

        // ==========================================
        // 🌟 扫描结束：更新统计并广播 (新版合并格式)
        // ==========================================
        if (currentScanVersion === version) {
            let totalSongs = 0;
            const folders = Object.keys(resultLibrary);
            for (const folder of folders) { totalSongs += resultLibrary[folder].length; }

            // 👇 新版合并曲库结构
            const compositeLib = {
                folders: folders.length,
                songs: totalSongs,
                time: getFormattedTime().slice(0, 16), // 获取类似 "2026-08-07 13:16" 的时间
                library: resultLibrary
            };

            const libraryJson = JSON.stringify(compositeLib);
            await safeStorageSet(`webdav_lib_${davId}`, libraryJson);

            try {
                // 直接发送合并后的对象给 iWebPlayer，不再单独发 stats
                await songloft.comm.send(TWIN_PLUGIN_ID, "sync_webdav_data", { type: 'library', davId: davId, library: libraryJson });
            } catch (e) {}

            scanStatus = 'completed';
            songloft.log.info(`[WebDAV] 节点 [${davId}] 全库扫描已完成！`);
        }
    } catch (fatalErr) {
        if (currentScanVersion === version) scanStatus = 'failed';
    }
}

// 🤖 静默后台定时扫描引擎
async function checkAutoScan() {
    if (scanStatus === 'scanning') return;

    try {
        const token = await songloft.plugin.getToken();
        const hostUrl = await songloft.plugin.getHostUrl();

        const res = await fetch(`${hostUrl}/api/v1/jsplugin/dav/lists`, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!res.ok) return;

        const servers = await res.json();
        if (!Array.isArray(servers)) return;

        // 🌟 统一获取 webdav_config
        const configStr = await songloft.storage.get('webdav_config');
        let config: any = { settings: {}, roots: {} };
        if (configStr) {
            try { config = JSON.parse(configStr); } catch (e) {}
        }

        for (const srv of servers) {
            if (scanStatus === 'scanning') break;
            const davId = srv.name;

            // 🌟 从 unified config 提取参数
            const intervalStr = config.settings[`auto_scan_interval_${davId}`] || '0';
            const intervalHours = parseInt(intervalStr, 10);

            if (intervalHours > 0) {
                const libStr = await songloft.storage.get(`webdav_lib_${davId}`);
                let lastScanMs = 0;
                if (libStr) {
                    try {
                        const libObj = JSON.parse(libStr);
                        if (libObj.time) {
                            lastScanMs = new Date(libObj.time.replace(/-/g, '/')).getTime();
                        }
                    } catch (e) {}
                }

                const now = Date.now();
                const targetIntervalMs = intervalHours * 60 * 60 * 1000;

                if (!lastScanMs || (now - lastScanMs >= targetIntervalMs)) {
                    songloft.log.info(`[WebDAV] 触发自动静默扫描: [${davId}]`);
                    const rootPath = config.roots[davId] || '/';

                    currentScanVersion++;
                    activeDavId = davId;
                    scanStatus = 'scanning';
                    scannedFoldersCount = 0;

                    await runScanTask(currentScanVersion, hostUrl, token, davId, rootPath);
                }
            }
        }
    } catch (e) {
        songloft.log.error('[WebDAV] 定时扫描守护进程异常: ' + String(e));
    }
}

// ==========================================
// 🔍 新增：专属 WebDAV 搜歌函数 (含 500 首防爆限制)
// ==========================================
export async function searchWebDavSongs(nodeName: string, keyword: string, logFn: (msg: string) => void): Promise<any[] | null> {
    try {
        let realNode = nodeName;
        if (nodeName === 'default') {
            try {
                const cfgRaw = await songloft.storage.get('webdav_config');
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

        const libStr = await songloft.storage.get(`webdav_lib_${realNode}`);

        // 🌟 在这里大声喊出未建立索引，并返回 null 中断流程
        if (!libStr) {
            logFn(`⚠️ WebDAV 节点 [${realNode}] 尚未建立曲库索引，请前往面板点击【建立全库索引】！`);
            return null;
        }

        const libData = JSON.parse(libStr);
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
        // 每 15 分钟醒来检查一次是否需要执行任务
        setInterval(() => {
            checkAutoScan().catch(() => {});
        }, 15 * 60 * 1000);

        // 插件刚启动时，延迟 1.5 分钟进行首次检查（错开宿主高负载启动期）
        setTimeout(() => {
            checkAutoScan().catch(() => {});
        }, 90 * 1000);

        songloft.log.info('[WebDAV] 自动定时扫描守护进程已启动');
    }

    router.post('/dav/scan', async (req: HTTPRequest) => {
        let data: any = {};
        if (req.body) {
            try { data = JSON.parse(typeof req.body === 'string' ? req.body : String.fromCharCode.apply(null, Array.from(req.body as Uint8Array))); } catch(e){}
        }
        const davId = data.davId;
        const rootPath = data.rootPath;
        if (!davId || !rootPath) return jsonResponse({ error: "Missing parameters" }, 400);

        const hostUrl = await songloft.plugin.getHostUrl();
        const token = await songloft.plugin.getToken();

        currentScanVersion++;
        activeDavId = davId;
        scanStatus = 'scanning';
        scannedFoldersCount = 0;

        runScanTask(currentScanVersion, hostUrl, token, davId, rootPath).catch(() => {});
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
        const cache = await songloft.storage.get(`webdav_lib_${davId}`);
        return jsonResponse(cache ? JSON.parse(cache) : {});
    });
}