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

async function importLxMusicAndPlay(lxSongs: any[], accountId: string, deviceId: string, logFn: (msg: string) => void) {
    if (!lxSongs || lxSongs.length === 0) { logFn('⚠️ LXMusic 导入列表为空'); return; }

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

        if (oldPlaylistId) {
            logFn(`🗑️ 找到旧推送歌单 (ID: ${oldPlaylistId})，正在清理...`);
            await fetch(`${hostUrl}/api/v1/playlists/${oldPlaylistId}`, { method: 'DELETE', headers });
        }

        logFn(`➕ 正在创建全新推送歌单...`);
        const createPlRes = await fetch(`${hostUrl}/api/v1/playlists`, { method: 'POST', headers, body: JSON.stringify({ name: 'iWebPlayer推送', type: 'normal' }) });
        if (!createPlRes.ok) throw new Error(`新建歌单被拒绝`);
        const newPlaylistId = (await createPlRes.json()).id;

        const songNames = lxSongs.map(s => s.name || s.title || '未知').slice(0, 3).join(', ') + (lxSongs.length > 3 ? ' 等' : '');
        logFn(`🔗 正在转存 ${lxSongs.length} 首歌曲 (如: ${songNames})...`);

        const importRes = await fetch(`${hostUrl}/api/v1/jsplugin/lxmusic/api/songs/import`, {
            method: 'POST', headers, body: JSON.stringify({ songs: lxSongs, playlist_id: String(newPlaylistId), new_playlist_name: "" })
        });
        if (!importRes.ok) throw new Error(`LXMusic 歌曲导入失败 (HTTP ${importRes.status})`);

        const importData = await importRes.json();
        logFn(`✅ 成功导入并绑定 ${importData?.data?.success || 0} 首歌进歌单！`);

        // 🌟 提取第一首歌，并修改文案
        const firstSongName = lxSongs[0]?.name || lxSongs[0]?.title || '未知歌曲';
        const totalStr = lxSongs.length > 1 ? ` 等 ${lxSongs.length} 首歌` : '';
        logFn(`🚀 正在呼叫小爱音箱即将播放: 《${firstSongName}》${totalStr}`);

        const playRes = await fetch(`${hostUrl}/api/v1/jsplugin/miot/player/play`, {
            method: 'POST', headers, body: JSON.stringify({ account_id: accountId, device_id: deviceId, playlist_id: newPlaylistId, start_index: 0, play_mode: 'order' })
        });
        if (playRes.ok) logFn(`🎉 播放指令下发成功！尽情享受音乐吧！`);
        else logFn(`❌ 小爱音箱播放下发失败 (HTTP ${playRes.status})`);

    } catch (err) { logFn(`❌ LXMusic 推歌异常: ` + String(err)); }
}

export async function handleLxMusicCommand(cmdType: string, platform: string, keyword: string, accountId: string, deviceId: string, strategy: string, targetQuality: string, logFn: (msg: string) => void) {
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

            if (list.length === 0) { logFn(`⚠️ 未搜到关于 "${keyword}" 的单曲，已熔断`); return; }

            lxSongsToImport = list.map((song: any) => {
                song.quality = resolveQuality(song.types, targetQuality);
                return song;
            });
            logFn(`🎯 成功检索到 ${lxSongsToImport.length} 首单曲 (目标期望音质: ${targetQuality})`);
        } catch(e) { logFn(`❌ LXMusic 搜歌接口异常: ${e}`); return; }

    } else if (cmdType === 'play') {
        logFn(`📂 开始在 LXMusic [${cnPlatform}] 检索歌单: "${keyword}" (挑选策略: ${cnStrategy})`);
        try {
            const url = `${hostUrl}/api/v1/jsplugin/lxmusic/api/songlist/search?source_id=${platform}&keyword=${encodeURIComponent(keyword)}&page=1&limit=30`;
            const res = await fetch(url, { headers });
            const data = await res.json();
            const list = data?.data?.list || [];

            if (list.length === 0) { logFn(`⚠️ 未搜到关于 "${keyword}" 的歌单，已熔断`); return; }

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

            if (songs.length === 0) { logFn(`⚠️ 该歌单为空`); return; }

            lxSongsToImport = songs.map((song: any) => {
                song.quality = resolveQuality(song.types, targetQuality);
                return song;
            });

            if (lxSongsToImport.length > 500) {
                logFn(`⚠️ 该歌单歌曲超限，已自动截断前 500 首防爆`);
                lxSongsToImport = lxSongsToImport.slice(0, 500);
            }
            logFn(`🎯 成功拉取并处理 ${lxSongsToImport.length} 首歌曲`);
        } catch(e) { logFn(`❌ LXMusic 搜单/详情接口异常: ${e}`); return; }
    }

    if (lxSongsToImport.length > 0) {
        await importLxMusicAndPlay(lxSongsToImport, accountId, deviceId, logFn);
    }
}