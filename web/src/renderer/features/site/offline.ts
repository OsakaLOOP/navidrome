import { get, set } from 'idb-keyval';
import { createWithEqualityFn } from 'zustand/traditional';

import { siteApi } from './site-api';

import { getItemImageUrl } from '/@/renderer/components/item-image/item-image';
import { useAuthStore } from '/@/renderer/store/auth.store';
import { LibraryItem, Song } from '/@/shared/types/domain-types';

export type OfflineEntry = {
    cover?: string;
    error?: string;
    file: string;
    size: number;
    song: Song;
    status: 'complete' | 'downloading' | 'error' | 'interrupted';
    total: number;
};
export const useOffline = createWithEqualityFn<{
    entries: OfflineEntry[];
    scope: string;
    supported: boolean;
}>(() => ({ entries: [], scope: '', supported: Boolean(navigator.storage?.getDirectory) }));
const controllers = new Map<string, AbortController>();
const tasks = new Map<string, Promise<void>>();
const catalogs = new Map<string, OfflineEntry[]>();
const urls = new Map<string, string>();
let writing = Promise.resolve();

export function offlineCoverUrl(imageId: string, serverUrl: string, userId?: string) {
    const owner = encodeURIComponent(`${serverUrl}|${userId}`);
    if (useOffline.getState().scope !== owner) return;
    return useOffline.getState().entries.find((entry) => entry.status === 'complete' && entry.song.imageId?.split('&')[0] === imageId)?.cover;
}

export function cancelOffline(id: string) {
    controllers.get(`${scope()}:${id}`)?.abort();
}

export async function clearOffline() {
    await loadOffline();
    for (const entry of [...useOffline.getState().entries]) await deleteOffline(entry.song.id);
}

export async function clearOfflineOwner(owner: string, remove: boolean) {
    for (const [key, controller] of controllers)
        if (key.startsWith(`${owner}:`)) controller.abort();
    await Promise.all(
        [...tasks].filter(([key]) => key.startsWith(`${owner}:`)).map(([, task]) => task),
    );
    for (const [key, url] of urls)
        if (key.startsWith(`${owner}:`)) {
            URL.revokeObjectURL(url);
            urls.delete(key);
        }
    if (remove) {
        const entries = (await get<OfflineEntry[]>(`ndfork-offline:${owner}`)) || [];
        if (navigator.storage?.getDirectory) {
            const root = await navigator.storage.getDirectory();
            const dir = await root.getDirectoryHandle('ndfork-music', { create: true });
            await dir.removeEntry(owner, { recursive: true }).catch(() => {});
        }
        const covers = await caches.open('ndfork-offline-covers');
        for (const entry of entries) if (entry.cover) await covers.delete(entry.cover);
        await persist(owner, []);
        catalogs.delete(owner);
    }
    if (useOffline.getState().scope === owner) useOffline.setState({ entries: [], scope: '' });
}

export async function deleteOffline(id: string) {
    const owner = scope();
    cancelOffline(id);
    await tasks.get(`${owner}:${id}`);
    const entriesForOwner = catalogs.get(owner) || [];
    const entry = entriesForOwner.find((e) => e.song.id === id);
    if (!entry) return;
    const dir = await directory(owner);
    await dir.removeEntry(entry.file).catch(() => {});
    if (entry.cover) await (await caches.open('ndfork-offline-covers')).delete(entry.cover);
    const url = urls.get(`${owner}:${id}`);
    if (url) URL.revokeObjectURL(url);
    urls.delete(`${owner}:${id}`);
    const entries = entriesForOwner.filter((e) => e.song.id !== id);
    catalogs.set(owner, entries);
    if (useOffline.getState().scope === owner) useOffline.setState({ entries });
    await persist(owner, entries);
}

export async function downloadOffline(song: Song) {
    await loadOffline();
    const owner = scope();
    if (!navigator.storage?.getDirectory) throw new Error('此浏览器尚未提供离线音频存储');
    const taskKey = `${owner}:${song.id}`;
    if (tasks.has(taskKey)) return tasks.get(taskKey);
    const task = saveDownload(owner, song);
    tasks.set(taskKey, task);
    try {
        await task;
    } finally {
        tasks.delete(taskKey);
    }
}

export async function loadOffline() {
    const owner = scope();
    if (useOffline.getState().scope === owner) return;
    const entries =
        catalogs.get(owner) ||
        ((await get<OfflineEntry[]>(`ndfork-offline:${owner}`)) || []).map((entry) =>
            entry.status === 'downloading' ? { ...entry, status: 'interrupted' as const } : entry,
        );
    catalogs.set(owner, entries);
    if (scope() === owner) useOffline.setState({ entries, scope: owner });
}

export async function offlineSongUrl(song: Song): Promise<string | undefined> {
    if (window.SERVER_NAME !== 'ndFork' || !navigator.storage?.getDirectory) return;
    await loadOffline();
    const owner = scope();
    const entry = useOffline
        .getState()
        .entries.find((e) => e.song.id === song.id && e.status === 'complete');
    if (!entry || (navigator.onLine && entry.song.updatedAt !== song.updatedAt)) return;
    const key = `${owner}:${song.id}`;
    if (urls.has(key)) return urls.get(key);
    try {
        const dir = await directory(owner);
        const file = await (await dir.getFileHandle(entry.file)).getFile();
        const url = URL.createObjectURL(file);
        urls.set(key, url);
        return url;
    } catch {
        return;
    }
}

async function directory(owner: string) {
    const root = await navigator.storage.getDirectory();
    const music = await root.getDirectoryHandle('ndfork-music', { create: true });
    return music.getDirectoryHandle(owner, { create: true });
}

async function persist(owner: string, entries: OfflineEntry[]) {
    const snapshot = structuredClone(entries);
    writing = writing.catch(() => {}).then(() => set(`ndfork-offline:${owner}`, snapshot));
    await writing;
}

async function saveDownload(owner: string, song: Song) {
    const taskKey = `${owner}:${song.id}`;
    const old = useOffline.getState().entries.find((e) => e.song.id === song.id);
    if (old?.status === 'complete' && old.song.updatedAt === song.updatedAt) return;
    const controller = new AbortController();
    controllers.set(taskKey, controller);
    const entry: OfflineEntry = {
        file: crypto.randomUUID(),
        size: 0,
        song,
        status: 'downloading',
        total: 0,
    };
    update(owner, entry);
    let writable: FileSystemWritableFileStream | undefined;
    try {
        await navigator.storage.persist();
        const dir = await directory(owner);
        const handle = await dir.getFileHandle(entry.file, { create: true });
        writable = await handle.createWritable();
        const parts = [song.id, song.updatedAt, 'raw', 0, 0].map((v) =>
            encodeURIComponent(String(v)),
        );
        const grant = await siteApi.request<{ url: string }>(
            `/site/media/stream/${parts.join('/')}?resolve=1`,
        );
        const response = await fetch(grant.url, { signal: controller.signal });
        if (!response.ok || !response.body) throw new Error(`下载失败 (${response.status})`);
        entry.total = Number(response.headers.get('Content-Length') || 0);
        const reader = response.body.getReader();
        await persist(owner, catalogs.get(owner) || []);
        let lastUpdate = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await writable.write(value);
            entry.size += value.byteLength;
            if (Date.now() - lastUpdate > 250) {
                update(owner, entry);
                lastUpdate = Date.now();
            }
        }
        if (entry.total && entry.size !== entry.total) throw new Error('下载未完成');
        await writable.close();
        writable = undefined;
        const image = getItemImageUrl({
            id: song.imageId || undefined,
            itemType: LibraryItem.SONG,
            size: 300,
        });
        if (image) {
            try {
                const cover = await fetch(image, { signal: controller.signal });
                if (cover.ok) {
                    entry.cover = `${location.origin}${location.pathname}offline-cover/${owner}/${entry.file}`;
                    const cache = await caches.open('ndfork-offline-covers');
                    await cache.put(entry.cover, cover);
                    entry.song = { ...song, imageUrl: entry.cover };
                }
            } catch {
                /* 音频已经完整保存，封面可在下次联网时更新。 */
            }
        }
        if (controller.signal.aborted) throw new DOMException('下载已取消', 'AbortError');
        entry.status = 'complete';
        if (old) {
            await dir.removeEntry(old.file).catch(() => {});
            if (old.cover) await (await caches.open('ndfork-offline-covers')).delete(old.cover);
        }
    } catch (error) {
        await writable?.abort().catch(() => {});
        entry.status = controller.signal.aborted ? 'interrupted' : 'error';
        entry.error = (error as Error).message;
        const dir = await directory(owner).catch(() => undefined);
        await dir?.removeEntry(entry.file).catch(() => {});
    } finally {
        controllers.delete(taskKey);
        update(
            owner,
            old?.status === 'complete' && entry.status !== 'complete'
                ? { ...old, error: entry.error }
                : entry,
        );
        await persist(owner, catalogs.get(owner) || []);
    }
}

function scope() {
    const server = useAuthStore.getState().currentServer;
    if (!server?.userId) throw new Error('请登录后下载');
    return encodeURIComponent(`${server.url}|${server.userId}`);
}

function update(owner: string, entry: OfflineEntry) {
    const entries = [...(catalogs.get(owner) || [])];
    const index = entries.findIndex((e) => e.song.id === entry.song.id);
    if (index < 0) entries.push({ ...entry });
    else entries[index] = { ...entry };
    catalogs.set(owner, entries);
    if (useOffline.getState().scope === owner) useOffline.setState({ entries });
}
