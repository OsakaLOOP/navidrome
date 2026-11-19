import { useMutation, useQueryClient } from '@tanstack/react-query';
import { t } from 'i18next';
import { useCallback, useEffect, useRef } from 'react';

import { confirmServerQueueRestore } from './confirm-server-queue-restore';

import { api } from '/@/renderer/api';
import { usePlayerEvents } from '/@/renderer/features/player/audio-player/hooks/use-player-events';
import { songsQueries } from '/@/renderer/features/songs/api/songs-api';
import {
    setTimestamp,
    useAuthStore,
    useCurrentServerId,
    usePlayerActions,
    usePlayerHydrated,
    usePlayerSong,
    usePlayerStatus,
    usePlayerStore,
    useTimestampStoreBase,
} from '/@/renderer/store';
import { isSharedPlayback } from '/@/renderer/store/player.store';
import { toast } from '/@/shared/components/toast/toast';
import { PlayerStatus } from '/@/shared/types/types';

let startupRestoreSessionHandled = false;

export const useQueueRestoreTimestamp = () => {
    const { mediaSeekToTimestamp } = usePlayerActions();

    usePlayerEvents(
        {
            onQueueRestored: (properties) => {
                const { position } = properties;
                const trackId = usePlayerStore.getState().getCurrentSong()?._uniqueId;

                setTimeout(() => {
                    if (
                        isSharedPlayback() ||
                        usePlayerStore.getState().getCurrentSong()?._uniqueId !== trackId
                    )
                        return;
                    setTimestamp(position);
                    mediaSeekToTimestamp(position);
                }, 100);
            },
        },
        [],
    );
};

export const QueueRestoreTimestampHook = () => {
    useQueueRestoreTimestamp();
    return null;
};

export const useInitialTimestampRestore = () => {
    const { mediaSeekToTimestamp } = usePlayerActions();
    const playerHydrated = usePlayerHydrated();
    const currentSong = usePlayerSong();
    const playerStatus = usePlayerStatus();
    const timestamp = useTimestampStoreBase((state) => state.timestamp);

    const startupRestoreInitializedRef = useRef(false);
    const startupSeekArmedRef = useRef<null | number>(null);
    const startupSeekTargetUniqueIdRef = useRef<null | string>(null);
    const startupSeekAppliedRef = useRef(false);

    const cancelStartupSeek = useCallback(() => {
        if (startupSeekAppliedRef.current) {
            return;
        }

        startupSeekAppliedRef.current = true;
        startupSeekArmedRef.current = null;
        startupSeekTargetUniqueIdRef.current = null;
    }, []);

    const applyStartupSeek = useCallback(() => {
        const seekTimestamp = startupSeekArmedRef.current;

        if (startupSeekAppliedRef.current) {
            return;
        }

        if (!seekTimestamp || seekTimestamp <= 0) {
            return;
        }

        const targetUniqueId = startupSeekTargetUniqueIdRef.current;
        const currentUniqueId = usePlayerStore.getState().getCurrentSong()?._uniqueId;

        if (targetUniqueId && currentUniqueId !== targetUniqueId) {
            cancelStartupSeek();
            return;
        }

        startupSeekAppliedRef.current = true;
        startupSeekArmedRef.current = null;
        startupSeekTargetUniqueIdRef.current = null;

        setTimeout(() => {
            if (
                !isSharedPlayback() &&
                usePlayerStore.getState().getCurrentSong()?._uniqueId === currentUniqueId
            )
                mediaSeekToTimestamp(seekTimestamp);
        }, 100);
    }, [cancelStartupSeek, mediaSeekToTimestamp]);

    useEffect(() => {
        const targetUniqueId = startupSeekTargetUniqueIdRef.current;
        if (
            !targetUniqueId ||
            startupSeekAppliedRef.current ||
            !currentSong ||
            currentSong._uniqueId === targetUniqueId
        ) {
            return;
        }

        cancelStartupSeek();
    }, [cancelStartupSeek, currentSong]);

    useEffect(() => {
        if (startupRestoreInitializedRef.current || startupRestoreSessionHandled) {
            return;
        }

        if (!playerHydrated || !currentSong) {
            return;
        }

        startupRestoreInitializedRef.current = true;
        startupRestoreSessionHandled = true;

        if (timestamp > 0) {
            startupSeekArmedRef.current = timestamp;
            startupSeekTargetUniqueIdRef.current = currentSong._uniqueId;
        }

        if (playerStatus === PlayerStatus.PLAYING) {
            applyStartupSeek();
        }
    }, [applyStartupSeek, currentSong, playerHydrated, playerStatus, timestamp]);

    usePlayerEvents(
        {
            onPlayerStatus: (properties) => {
                if (properties.status === PlayerStatus.PLAYING) {
                    applyStartupSeek();
                }
            },
        },
        [applyStartupSeek],
    );
};

export const InitialTimestampRestoreHook = () => {
    useInitialTimestampRestore();
    return null;
};

export const useSaveQueue = () => {
    const serverId = useCurrentServerId();

    const mutation = useMutation({
        mutationFn: async () => {
            if (isSharedPlayback()) return;
            if (!serverId) {
                throw new Error(t('error.serverRequired'));
            }

            const state = usePlayerStore.getState();
            const queue = state.getQueue();

            if (queue.items.some((item) => item._serverId !== serverId)) {
                toast.error({
                    message: t('error.multipleServerSaveQueueError'),
                    title: t('error.genericError'),
                });

                throw new Error(`${t('error.multipleServerSaveQueueError')}`);
            }

            return api.controller.savePlayQueue({
                apiClientProps: { serverId },
                query: {
                    currentIndex: queue.items.length > 0 ? state.player.index : undefined,
                    positionMs: useTimestampStoreBase.getState().timestamp * 1000,
                    songs: queue.items.map((item) => item.id),
                },
            });
        },
        onError: (error) => {
            toast.error({
                message: (error as Error).message,
                title: t('error.saveQueueFailed'),
            });
        },
    });

    return mutation;
};

export const useRestoreQueue = () => {
    const serverId = useCurrentServerId();
    const queryClient = useQueryClient();

    const handleRestoreQueue = useCallback(async () => {
        if (!serverId || isSharedPlayback()) return;
        const account = useAuthStore.getState().currentServer?.userId;

        try {
            const queue = await queryClient.fetchQuery(
                songsQueries.getQueue({ query: {}, serverId }),
            );

            if (queue) {
                const restore = () => {
                    const server = useAuthStore.getState().currentServer;
                    if (isSharedPlayback() || server?.id !== serverId || server.userId !== account)
                        return;
                    usePlayerStore
                        .getState()
                        .setQueue(
                            queue.entry,
                            queue.currentIndex,
                            queue.positionMs !== undefined ? queue.positionMs / 1000 : undefined,
                        );
                };
                if (usePlayerStore.getState().getQueue().items.length)
                    confirmServerQueueRestore(false, restore);
                else restore();
            }
        } catch (error) {
            toast.error({
                message: (error as Error).message,
                title: t('error.genericError'),
            });
        }
    }, [queryClient, serverId]);

    return handleRestoreQueue;
};
