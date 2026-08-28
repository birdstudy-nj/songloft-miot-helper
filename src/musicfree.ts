// src/musicfree.ts
/// <reference types="@songloft/plugin-sdk" />

// ==========================================
// 🎵 MusicFree 搜索引擎 (带 5 秒熔断与自动翻页)
// ==========================================
export async function searchMusicFreeSongs(nodeName: string, keyword: string, quality: string, limit: number, logFn: (msg: string) => void): Promise<any[] | null> {
    try {
        const hostUrl = await songloft.plugin.getHostUrl();
        const token = await songloft.plugin.getToken();
        const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

        const qMap: Record<string, string> = { '128k': 'low', '320k': 'standard', 'flac': 'high' };
        let targetQuality = qMap[quality] || quality;

        logFn(`⚙️ 向 MusicFree 引擎应用全局音质: [${targetQuality}]`);
        await fetch(`${hostUrl}/api/v1/jsplugin/musicfree-adapter/settings`, {
            method: 'PUT', headers, body: JSON.stringify({ defaultQuality: targetQuality })
        });

        let platform = nodeName;
        if (platform === 'default') {
            const plRes = await fetch(`${hostUrl}/api/v1/jsplugin/musicfree-adapter/plugins`, { headers });
            if (plRes.ok) {
                const plData = await plRes.json();
                const firstActive = (plData.plugins || []).find((p: any) => p.enabled && p.platform);
                if (firstActive) {
                    platform = firstActive.platform;
                    logFn(`💡 动态匹配首个可用源: [${platform}]`);
                } else {
                    logFn(`⚠️ MusicFree 没有找到任何已启用的源！`);
                    return null;
                }
            }
        }

        logFn(`🔍 开始在 MusicFree 平台 [${platform}] 中搜歌: "${keyword}"`);

        let page = 1;
        let results: any[] = [];
        const startTime = Date.now();

        while (true) {
            const searchUrl = `${hostUrl}/api/v1/jsplugin/musicfree-adapter/search?q=${encodeURIComponent(keyword)}&page=${page}&type=music&platform=${encodeURIComponent(platform)}`;

            const timeRemaining = 5000 - (Date.now() - startTime);
            if (timeRemaining <= 0) {
                logFn(`⏱️ 搜歌耗时已超 5 秒，触发防卡死熔断，立即返回现有 ${results.length} 首`);
                break;
            }

            const res = await fetch(searchUrl, {
                headers: { ...headers, 'X-Fetch-Timeout-Ms': String(Math.max(1000, timeRemaining)) }
            });

            if (!res.ok) {
                logFn(`⚠️ MF 搜索请求失败 (HTTP ${res.status})`);
                break;
            }

            const data = await res.json();
            const items = data.data || [];
            if (items.length === 0) break;

            for (const item of items) {
                let artistStr = item.artist || '未知歌手';
                if (Array.isArray(item.artistItems) && item.artistItems.length > 0) {
                    artistStr = item.artistItems.map((a: any) => a.name).join('、');
                }

                // 🌟 极简修复：如果是 "04:57" 会变 NaN，进而变成 0。
                const numDur = Number(item.duration);
                const safeDuration = isNaN(numDur) ? 0 : numDur;
                item.duration = safeDuration; // 覆盖回 item，确保 source_data 里也是数字 0

                results.push({
                    title: item.title || '未知歌曲',
                    artist: artistStr,
                    album: item.album || '',
                    cover_url: item.artwork || item.cover_url || item.pic || '',
                    url: '',
                    duration: safeDuration,
                    dedup_key: `${item.platform || platform}:${item.id}`,
                    plugin_entry_path: 'musicfree-adapter',
                    source_data: JSON.stringify(item),
                    lyric: ''
                });

                if (results.length >= limit) break;
            }

            if (results.length >= limit) {
                logFn(`✂️ 已达到期望数量限制 (${limit}首)，停止翻页`);
                break;
            }
            if (data.isEnd) {
                logFn(`✅ 源端提示已无更多数据，停止翻页`);
                break;
            }
            if (Date.now() - startTime > 5000) {
                logFn(`⏱️ 搜歌耗时已超 5 秒，触发防卡死熔断，立即返回现有 ${results.length} 首`);
                break;
            }
            page++;
        }

        return results;
    } catch (e) {
        logFn(`❌ MusicFree 搜歌异常: ` + String(e));
        return null;
    }
}

// ==========================================
// 📂 MusicFree 搜歌单引擎 (含智能策略与自动抓取明细)
// ==========================================
export async function searchMusicFreePlaylists(nodeName: string, keyword: string, quality: string, strategy: string, limit: number, logFn: (msg: string) => void): Promise<{ songs: any[], collectionName: string } | null> {
    try {
        const hostUrl = await songloft.plugin.getHostUrl();
        const token = await songloft.plugin.getToken();
        const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

        const qMap: Record<string, string> = { '128k': 'low', '320k': 'standard', 'flac': 'high' };
        let targetQuality = qMap[quality] || quality;
        logFn(`⚙️ 向 MusicFree 引擎应用全局音质: [${targetQuality}]`);
        await fetch(`${hostUrl}/api/v1/jsplugin/musicfree-adapter/settings`, {
            method: 'PUT', headers, body: JSON.stringify({ defaultQuality: targetQuality })
        });

        let platform = nodeName;
        if (platform === 'default') {
            const plRes = await fetch(`${hostUrl}/api/v1/jsplugin/musicfree-adapter/plugins`, { headers });
            if (plRes.ok) {
                const plData = await plRes.json();
                const firstActive = (plData.plugins || []).find((p: any) => p.enabled && p.platform);
                if (firstActive) {
                    platform = firstActive.platform;
                    logFn(`💡 动态匹配首个可用源: [${platform}]`);
                } else {
                    logFn(`⚠️ MusicFree 没有找到任何已启用的源！`);
                    return null;
                }
            }
        }

        const stratMap: Record<string, string> = { first: '默认首个', random: '随机抽取', play_count: '热度优先', total: '数量优先' };
        const cnStrategy = stratMap[strategy] || strategy;

        logFn(`📂 开始在 MusicFree 平台 [${platform}] 中检索歌单: "${keyword}" (挑选策略: ${cnStrategy})`);

        const searchUrl = `${hostUrl}/api/v1/jsplugin/musicfree-adapter/search?q=${encodeURIComponent(keyword)}&page=1&type=sheet&platform=${encodeURIComponent(platform)}`;
        let plRes;
        try {
            plRes = await fetch(searchUrl, {
                headers: { ...headers, 'X-Fetch-Timeout-Ms': '8000' }
            });
        } catch (fetchErr) {
            logFn(`⚠️ 歌单检索请求超时或网络异常，已熔断`);
            return null;
        }

        if (!plRes.ok) {
            logFn(`⚠️ 歌单检索请求失败 (HTTP ${plRes.status})`);
            return null;
        }

        const plData = await plRes.json();
        const sheets = plData.data || [];

        if (sheets.length === 0) {
            logFn(`⚠️ 未搜到关于 "${keyword}" 的歌单，已熔断`);
            return null;
        }

        logFn(`💡 第一页抓到 ${sheets.length} 个相关歌单，进行智能决选...`);
        let selectedSheet = sheets[0];

        if (strategy === 'random') {
            selectedSheet = sheets[Math.floor(Math.random() * sheets.length)];
        } else if (strategy === 'play_count') {
            const hasPlayCount = sheets.some((s: any) => s.playCount !== undefined && s.playCount !== null);
            if (hasPlayCount) {
                selectedSheet = sheets.reduce((prev: any, curr: any) => (parseInt(curr.playCount) || 0) > (parseInt(prev.playCount) || 0) ? curr : prev);
            } else {
                logFn(`⚠️ 源数据缺失 playCount，[热度优先] 自动降级为 [随机抽取]`);
                selectedSheet = sheets[Math.floor(Math.random() * sheets.length)];
            }
        } else if (strategy === 'total') {
            const hasWorksNum = sheets.some((s: any) => s.worksNum !== undefined && s.worksNum !== null);
            if (hasWorksNum) {
                selectedSheet = sheets.reduce((prev: any, curr: any) => (parseInt(curr.worksNum) || 0) > (parseInt(prev.worksNum) || 0) ? curr : prev);
            } else {
                logFn(`⚠️ 源数据缺失 worksNum，[数量优先] 自动降级为 [随机抽取]`);
                selectedSheet = sheets[Math.floor(Math.random() * sheets.length)];
            }
        }

        const sTitle = selectedSheet.title || '未命名歌单';
        logFn(`🎯 命中歌单: [${sTitle}] (标识ID: ${selectedSheet.id})`);

        let page = 1;
        let results: any[] = [];
        const startTime = Date.now();
        const sType = selectedSheet.type || 'sheet';

        logFn(`⏳ 正在抓取歌单 [${sTitle}] 内的歌曲明细 (5秒倒计时)...`);

        while (true) {
            const timeRemaining = 5000 - (Date.now() - startTime);
            if (timeRemaining <= 0) {
                logFn(`⏱️ 明细抓取耗时已超 5 秒，触发防卡死熔断，立即返回已有的 ${results.length} 首`);
                break;
            }

            const detailUrl = `${hostUrl}/api/v1/jsplugin/musicfree-adapter/recommend-sheets/detail?platform=${encodeURIComponent(platform)}&id=${encodeURIComponent(selectedSheet.id)}&page=${page}&pageSize=50&type=${encodeURIComponent(sType)}`;
            let dRes;
            try {
                dRes = await fetch(detailUrl, {
                    headers: { ...headers, 'X-Fetch-Timeout-Ms': String(Math.max(1000, timeRemaining)) }
                });
            } catch (err) {
                logFn(`⏱️ 拉取第 ${page} 页时发生超时或中断，立即返回已有的 ${results.length} 首`);
                break;
            }

            if (!dRes.ok) {
                logFn(`⚠️ 获取歌单明细失败 (HTTP ${dRes.status})`);
                break;
            }

            const dData = await dRes.json();
            const items = dData.songs || dData.data || [];

            if (items.length === 0) break;

            for (const item of items) {
                let artistStr = item.artist || '未知歌手';
                if (Array.isArray(item.artistItems) && item.artistItems.length > 0) {
                    artistStr = item.artistItems.map((a: any) => a.name).join('、');
                }

                // 🌟 极简修复：转数字，如果不合法就赋 0
                const numDur = Number(item.duration);
                const safeDuration = isNaN(numDur) ? 0 : numDur;
                item.duration = safeDuration; // 覆盖回 item

                results.push({
                    title: item.title || '未知歌曲',
                    artist: artistStr,
                    album: item.album || '',
                    cover_url: item.artwork || item.cover_url || item.pic || '',
                    url: '',
                    duration: safeDuration,
                    dedup_key: `${item.platform || platform}:${item.id}`,
                    plugin_entry_path: 'musicfree-adapter',
                    source_data: JSON.stringify(item),
                    lyric: ''
                });

                if (results.length >= limit) break;
            }

            if (results.length >= limit) {
                logFn(`✂️ 歌单歌曲达到期望数量限制 (${limit}首)，停止翻页`);
                break;
            }
            if (dData.isEnd) {
                logFn(`✅ 歌单歌曲已全部抓取完毕`);
                break;
            }
            if (Date.now() - startTime > 5000) {
                logFn(`⏱️ 明细抓取耗时已超 5 秒，触发防卡死熔断，立即返回已有的 ${results.length} 首`);
                break;
            }
            page++;
        }

        return { songs: results, collectionName: sTitle };

    } catch (e) {
        logFn(`❌ MusicFree 搜歌单异常: ` + String(e));
        return null;
    }
}