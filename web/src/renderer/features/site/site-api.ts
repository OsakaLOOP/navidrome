import { queryClient } from '/@/renderer/lib/react-query';
import { useAuthStore } from '/@/renderer/store/auth.store';
import { usePlayerStoreBase } from '/@/renderer/store/player.store';
import { ServerType } from '/@/shared/types/types';

export const siteApi = {
    async request<T>(path: string, body?: unknown, method?: string): Promise<T> {
        const server = useAuthStore.getState().currentServer;
        const file = body instanceof Blob ? body : undefined;
        const response = await fetch(`${server?.url || window.SERVER_URL}${path}`, {
            body: file ?? (body === undefined ? undefined : JSON.stringify(body)),
            credentials: 'include',
            headers: {
                'Content-Type': file?.type || 'application/json',
                ...(server?.ndCredential
                    ? { 'x-nd-authorization': `Bearer ${server.ndCredential}` }
                    : {}),
            },
            method: method || (body === undefined ? 'GET' : 'POST'),
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.message || response.statusText);
        }
        return response.status === 204 ? (undefined as T) : response.json();
    },
};

export type SiteAuth = {
    id: string;
    isAdmin: boolean;
    subsonicSalt: string;
    subsonicToken: string;
    token: string;
    twoFactorRequired?: boolean;
    username: string;
};

export function acceptSiteAuth(data: SiteAuth) {
    const store = useAuthStore.getState();
    const url = window.SERVER_URL || window.location.origin;
    if (store.currentServer?.userId && store.currentServer.userId !== data.id) {
        queryClient.clear();
        usePlayerStoreBase.getState().clearQueue();
    }
    const server = Object.values(store.serverList).find((s) => s.url === url);
    const item = {
        ...server,
        credential: `u=${encodeURIComponent(data.username)}&jwt=${encodeURIComponent(data.token)}`,
        id: server?.id || 'ndfork',
        isAdmin: data.isAdmin,
        name: 'ndFork',
        ndCredential: data.token,
        type: ServerType.NAVIDROME,
        url,
        userId: data.id,
        username: data.username,
    };
    store.actions.addServer(item);
    store.actions.setCurrentServer(item);
}

export async function renewSiteSession() {
    if (!navigator.onLine || !useAuthStore.getState().currentServer) return;
    const data = await restoreSiteSession();
    acceptSiteAuth(data);
}

export async function restoreSiteSession() {
    if (sessionStorage.getItem('ndfork-signed-out')) throw new Error('请登录');
    try {
        return await siteApi.request<SiteAuth>('/auth/session');
    } catch {
        const origin = (window as Window & { SERVERMAN_URL?: string }).SERVERMAN_URL;
        if (!origin || sessionStorage.getItem('ndfork-signed-out')) throw new Error('请登录');
        const response = await fetch(`${origin}/api/auth/token`, { credentials: 'include' });
        if (!response.ok) throw new Error('请登录');
        const { token } = await response.json();
        return siteApi.request<SiteAuth>('/auth/exchange', { token });
    }
}
