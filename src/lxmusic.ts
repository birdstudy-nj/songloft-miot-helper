// src/lxmusic.ts
/// <reference types="@songloft/plugin-sdk" />

function resolveQuality(types: any[], targetQuality: string): string {
    if (!types || !Array.isArray(types) || types.length === 0) return '128k';
    const available = types.map((t: any) => t.type);
    if (available.includes(targetQuality)) return targetQuality;

    const ladder = ['master', 'flac24bit', 'flac', '320k', '192k', '128k'];
    for (const q of ladder) {
        if (available.includes(q)) return q;
    }
    return available[0] || '128k';
}

function parsePlayCount(str: string): number {
    if (!str) return 0;
    let num = parseFloat(str);
    if (str.includes('亿')) num *= 100000000;
    else if (str.includes('万')) num *= 10000;
    return isNaN(num) ? 0 : num;
}

export async function searchLxMusicSongs(cmdType: string, platform: string, keyword: string, strategy: string, targetQuality: string, logFn: (msg: string) => void): Promise<any[] | null> {
    const hostUrl = await songloft.plugin.getHostUrl();
    const token = await songloft.plugin.getToken();
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
    let lxSongsToImport: any[] = [];

    const stratMap: Record<string, string> = { first: '默认首个', random: '随机抽取', play_count: '热度优先', total: '数量优先' };
    const platMap: Record<string, string> = { wy: '网易云', tx: 'QQ音乐', kg: '酷狗', kw: '酷我', mg: '咪咕' };
    const cnPlatform = platMap[platform] || platform;
    const cnStrategy = stratMap[strategy] || strategy;

    if (cmdType === 'search') {
        logFn(`🔍 开始在 LXMusic [${cnPlatform}] 检索单曲: "${keyword}"`);
        try {
            const reqBody = { keyword: keyword, source_id: platform, type: 'song', page: 1 };
            const res = await fetch(`${hostUrl}/api/v1/jsplugin/lxmusic/api/search`, { method: 'POST', headers, body: JSON.stringify(reqBody) });
            const data = await res.json();
            const list = data?.data?.list || [];

            if (list.length === 0) { logFn(`⚠️ 未搜到关于 "${keyword}" 的单曲，已熔断`); return []; }

            lxSongsToImport = list.map((song: any) => {
                song.quality = resolveQuality(song.types, targetQuality);
                return song;
            });
            logFn(`🎯 成功检索到 ${lxSongsToImport.length} 首单曲 (目标期望音质: ${targetQuality})`);
        } catch(e) { logFn(`❌ LXMusic 搜歌接口异常: ${e}`); return null; }

    } else if (cmdType === 'play') {
        logFn(`📂 开始在 LXMusic [${cnPlatform}] 检索歌单: "${keyword}" (挑选策略: ${cnStrategy})`);
        try {
            const url = `${hostUrl}/api/v1/jsplugin/lxmusic/api/songlist/search?source_id=${platform}&keyword=${encodeURIComponent(keyword)}&page=1&limit=30`;
            const res = await fetch(url, { headers });
            const data = await res.json();
            const list = data?.data?.list || [];

            if (list.length === 0) { logFn(`⚠️ 未搜到关于 "${keyword}" 的歌单，已熔断`); return []; }

            logFn(`💡 搜到 ${list.length} 个相关歌单，使用 [${cnStrategy}] 策略进行决选...`);
            let selectedPlaylist = list[0];

            if (strategy === 'random') {
                selectedPlaylist = list[Math.floor(Math.random() * list.length)];
            } else if (strategy === 'play_count') {
                selectedPlaylist = list.reduce((prev: any, curr: any) => parsePlayCount(curr.play_count) > parsePlayCount(prev.play_count) ? curr : prev);
            } else if (strategy === 'total') {
                selectedPlaylist = list.reduce((prev: any, curr: any) => parseInt(curr.total || '0') > parseInt(prev.total || '0') ? curr : prev);
            }

            logFn(`🎯 命中歌单: [${selectedPlaylist.name}] (播放量: ${selectedPlaylist.play_count || 0}, 曲目: ${selectedPlaylist.total || 0})`);
            logFn(`⏳ 正在拉取该歌单明细...`);

            const detailUrl = `${hostUrl}/api/v1/jsplugin/lxmusic/api/songlist/detail?source_id=${platform}&id=${selectedPlaylist.id}&page=1`;
            const detailRes = await fetch(detailUrl, { headers });
            const detailData = await detailRes.json();
            const songs = detailData?.data?.list || [];

            if (songs.length === 0) { logFn(`⚠️ 该歌单为空`); return []; }

            lxSongsToImport = songs.map((song: any) => {
                song.quality = resolveQuality(song.types, targetQuality);
                return song;
            });

            if (lxSongsToImport.length > 500) {
                logFn(`⚠️ 该歌单歌曲超限，已自动截断前 500 首防爆`);
                lxSongsToImport = lxSongsToImport.slice(0, 500);
            }
            logFn(`🎯 成功拉取并处理 ${lxSongsToImport.length} 首歌曲`);
        } catch(e) { logFn(`❌ LXMusic 搜单/详情接口异常: ${e}`); return null; }

    } else if (cmdType === 'singer') {
        logFn(`🎤 开始在 LXMusic [${cnPlatform}] 检索歌手: [${keyword}]`);
        try {
            let raw: any[] = [];

            // 🌟 1. 首选：原生 singer 接口 (尝试翻页取 40~50 首左右)
            try {
                let page = 1;
                while (raw.length < 50 && page <= 3) {
                    const res = await fetch(`${hostUrl}/api/v1/jsplugin/lxmusic/api/search`, { method: 'POST', headers, body: JSON.stringify({ keyword: keyword, source_id: platform, type: 'singer', page: page }) });
                    const data = await res.json();
                    const list = data?.data?.list || [];
                    if (list.length === 0) break;
                    raw = raw.concat(list);
                    if (data?.data?.has_more === false) break;
                    page++;
                }
            } catch (e) { logFn(`⚠️ 原生歌手接口异常，准备降级: ${e}`); }

            // 🌟 2. 双保险兜底：降级至 song 泛搜，只取首页前20首
            if (raw.length === 0) {
                logFn(`⚠️ 专属歌手接口无数据，降级使用单曲泛搜模式(仅截取首页20首)...`);
                const res = await fetch(`${hostUrl}/api/v1/jsplugin/lxmusic/api/search`, { method: 'POST', headers, body: JSON.stringify({ keyword: keyword, source_id: platform, type: 'song', page: 1 }) });
                const data = await res.json();
                raw = (data?.data?.list || []).slice(0, 20);
            }

            if (raw.length === 0) { logFn(`⚠️ 未搜到歌手 "${keyword}" 的任何歌曲，已熔断`); return []; }

            lxSongsToImport = raw.map((s: any) => { s.quality = resolveQuality(s.types, targetQuality); return s; });
            logFn(`🎯 成功检索到歌手 [${keyword}] 的 ${lxSongsToImport.length} 首歌曲`);
        } catch (e) { logFn(`❌ LXMusic 歌手检索异常: ${e}`); return null; }

    } else if (cmdType === 'rank') {
        let kw = keyword || '热歌榜';
        logFn(`🏆 匹配排行榜: "${kw}" (首选平台: ${cnPlatform})`);

        const candidates = [platform, 'tx', 'kw', 'kg', 'wy', 'mg'].filter((v, i, a) => a.indexOf(v) === i);
        let board: any = null;
        let usedPlat = platform;

        for (const cp of candidates) {
            try {
                const bres = await fetch(`${hostUrl}/api/v1/jsplugin/lxmusic/api/leaderboard/boards?source_id=${cp}`, { headers });
                const bdata = await bres.json();
                const boards = bdata?.data || [];
                if (boards.length === 0) continue;
                board = boards.find((b: any) => b.name === kw) ||
                        boards.find((b: any) => b.name.includes(kw)) ||
                        boards.find((b: any) => kw.includes(b.name));
                if (board) { usedPlat = cp; break; }
            } catch(e) {}
        }

        if (!board) { logFn(`⚠️ 未在任何平台匹配到排行榜 "${kw}"`); return []; }

        logFn(`🎯 命中排行榜: [${platMap[usedPlat]||usedPlat}] ${board.name}，正在拉取歌曲...`);
        try {
            let page = 1;
            while (true) {
                const lres = await fetch(`${hostUrl}/api/v1/jsplugin/lxmusic/api/leaderboard/list?source_id=${usedPlat}&board_id=${encodeURIComponent(board.bangid)}&page=${page}`, { headers });
                const ldata = await lres.json();
                const pageList = ldata?.data?.list || [];
                if (pageList.length === 0) break;
                for (const s of pageList) {
                    s.quality = resolveQuality(s.types, targetQuality);
                    lxSongsToImport.push(s);
                }
                if (lxSongsToImport.length >= 500 || ldata?.data?.has_more === false) break;
                page++;
                if (page > 10) break;
            }
            logFn(`🎯 成功拉取排行榜 [${board.name}] 共 ${lxSongsToImport.length} 首歌曲`);
        } catch (e) { logFn(`❌ LXMusic 排行榜接口异常: ${e}`); return null; }

    } else if (cmdType === 'album') {
        logFn(`💿 开始在 LXMusic [${cnPlatform}] 检索专辑: "${keyword}"`);
        try {
            let raw: any[] = [];
            let isNativeSuccess = false;

            // 🌟 1. 首选：原生 album 接口 (由于一张专辑一般也就十几首歌，翻2页足够)
            try {
                let page = 1;
                while (raw.length < 50 && page <= 2) {
                    const res = await fetch(`${hostUrl}/api/v1/jsplugin/lxmusic/api/search`, { method: 'POST', headers, body: JSON.stringify({ keyword: keyword, source_id: platform, type: 'album', page: page }) });
                    const data = await res.json();
                    const list = data?.data?.list || [];
                    if (list.length === 0) break;
                    raw = raw.concat(list);
                    if (data?.data?.has_more === false) break;
                    page++;
                }
                if (raw.length > 0) isNativeSuccess = true;
            } catch(e) { logFn(`⚠️ 原生专辑接口异常，准备降级: ${e}`); }

            // 🌟 2. 双保险兜底：降级至 song 泛搜 + 本地聚类清洗
            if (isNativeSuccess) {
                logFn(`🎯 原生专辑接口命中，直接采用返回的 ${raw.length} 首歌曲`);
                lxSongsToImport = raw.map((s: any) => { s.quality = resolveQuality(s.types, targetQuality); return s; });
            } else {
                logFn(`⚠️ 专属专辑接口无数据，降级使用单曲泛搜+智能清洗模式(仅取首页20首)...`);
                const sres = await fetch(`${hostUrl}/api/v1/jsplugin/lxmusic/api/search`, { method: 'POST', headers, body: JSON.stringify({ keyword: keyword, source_id: platform, type: 'song', page: 1 }) });
                const sdata = await sres.json();
                raw = (sdata?.data?.list || []).slice(0, 20);

                if (raw.length === 0) { logFn(`⚠️ 未搜到相关结果，已熔断`); return []; }

                // 开始执行本地智能清洗
                const albumCounts: Record<string, number> = {};
                for (const s of raw) { const a = (s.album || '').trim(); if (a) albumCounts[a] = (albumCounts[a] || 0) + 1; }
                let bestAlbum = null, bestAlbumCount = -1;
                for (const a in albumCounts) { if (albumCounts[a] > bestAlbumCount) { bestAlbumCount = albumCounts[a]; bestAlbum = a; } }

                let kept = bestAlbum ? raw.filter((s:any) => (s.album||'').trim() === bestAlbum) : raw.filter((s:any) => (s.album||'').includes(keyword));
                if (kept.length === 0) kept = raw;

                const top10 = kept.slice(0, 10);
                const artistCounts: Record<string, number> = {};
                for (const s of top10) { const ar = (s.singer || s.artist || '').trim(); if (ar) artistCounts[ar] = (artistCounts[ar] || 0) + 1; }
                let bestArtist = null, bestArtistCount = -1;
                for (const ar in artistCounts) { if (artistCounts[ar] > bestArtistCount) { bestArtistCount = artistCounts[ar]; bestArtist = ar; } }
                if (!bestArtist && top10.length) bestArtist = (top10[0].singer || top10[0].artist || '').trim();

                if (bestArtist) {
                    kept = kept.filter((s:any) => ((s.singer || s.artist) || '').trim() === bestArtist);
                    logFn(`💿 降级清洗命中专辑 [${bestAlbum || keyword}] (主歌手: ${bestArtist})`);
                }

                lxSongsToImport = kept.map((s: any) => { s.quality = resolveQuality(s.types, targetQuality); return s; });
                logFn(`🎯 成功清洗并锁定专辑共 ${lxSongsToImport.length} 首歌曲`);
            }
        } catch (e) { logFn(`❌ LXMusic 专辑检索异常: ${e}`); return null; }
    }

    return lxSongsToImport;
}