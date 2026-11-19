import { useQuery } from '@tanstack/react-query';
import formatDuration from 'format-duration';
import { AnimatePresence, motion } from 'motion/react';
import { nanoid } from 'nanoid';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { generatePath, Link } from 'react-router';
import { createWithEqualityFn } from 'zustand/traditional';

import { RoomMember, RoomMembers } from './room-members';
import styles from './room.module.css';
import { siteApi } from './site-api';
import siteStyles from './site.module.css';

import i18n from '/@/i18n/i18n';
import { api } from '/@/renderer/api';
import { confirmServerQueueRestore } from '/@/renderer/features/player/hooks/confirm-server-queue-restore';
import { openCreatePrefilledPlaylistModal } from '/@/renderer/features/playlists/components/create-playlist-form';
import { openImportQueueModal } from '/@/renderer/features/playlists/components/import-queue-modal';
import { searchQueries } from '/@/renderer/features/search/api/search-api';
import { openSettingsModal } from '/@/renderer/features/settings/utils/open-settings-modal';
import { LibraryHeaderBar } from '/@/renderer/features/shared/components/library-header-bar';
import { AppRoute } from '/@/renderer/router/routes';
import {
    useAuthStore,
    useListenTogetherSettings,
    usePlayerSong,
    usePlayerTimestamp,
    useSettingsStore,
} from '/@/renderer/store';
import {
    beginSharedPlayback,
    endSharedPlayback,
    SharedPlaybackCommand,
    syncSharedSong,
    usePlayerStoreBase,
} from '/@/renderer/store/player.store';
import { useTimestampStoreBase } from '/@/renderer/store/timestamp.store';
import { logger } from '/@/renderer/utils/logger';
import { shuffle } from '/@/renderer/utils/shuffle';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Button } from '/@/shared/components/button/button';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { Image } from '/@/shared/components/image/image';
import { Popover } from '/@/shared/components/popover/popover';
import { Slider } from '/@/shared/components/slider/slider';
import { Stack } from '/@/shared/components/stack/stack';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { Text } from '/@/shared/components/text/text';
import { toast } from '/@/shared/components/toast/toast';
import { useDebouncedValue } from '/@/shared/hooks/use-debounced-value';
import { LibraryItem, QueueSong } from '/@/shared/types/domain-types';
import { Play } from '/@/shared/types/types';

type Announcement = {
    createdAt: number;
    id: number;
    message: string;
    userId: string;
    userName: string;
};

type Entry = {
    addedBy: string;
    album?: string;
    albumId: string;
    artist: string;
    artistId: string;
    duration: number;
    id: string;
    name: string;
    songId: string;
    unavailable?: boolean;
    year?: number;
};

type Room = {
    announcement?: Announcement | null;
    index: number;
    joined: boolean;
    memberCount: number;
    members: Record<string, RoomMember>;
    onlineCount: number;
    playing: boolean;
    position: number;
    queue: Entry[];
    serverTime: number;
    session: string;
    updatedAt: number;
    version: number;
};

const account = () => {
    const server = useAuthStore.getState().currentServer;
    return server ? `${server.id}:${server.userId}` : '';
};

const useRoom = createWithEqualityFn<{
    busy: boolean;
    error: string;
    member: string;
    preview: null | Room;
    room: null | Room;
}>(() => ({ busy: false, error: '', member: '', preview: null, room: null }));

let device = '';
const membershipKey = 'ndfork-room-member';
const SEEK_RESOLVE_MS = 1000;
const STALE_ANNOUNCEMENT_MS = 60_000;
let suppressNextStartNotice = false;

class SiteRoomConflict extends Error {
    constructor(public room: Room) {
        super('409');
    }
}

export function isRoomActive() {
    return Boolean(useRoom.getState().member);
}

/** 共享房间全局桥接：处理播放同步、未加入时的活跃态预览轮询以及开始/广播提醒 */
export function RoomBridge() {
    const { t } = useTranslation();
    const member = useRoom((state) => state.member);
    const room = useRoom((state) => state.room);
    const preview = useRoom((state) => state.preview);
    const serverId = useAuthStore((state) => state.currentServer?.id);
    const userId = useAuthStore((state) => state.currentServer?.userId);
    const hydrated = usePlayerStoreBase((state) => state.hydrated);
    const settings = useListenTogetherSettings();

    const lastAnnouncementIdRef = useRef<null | number>(null);
    const prevMemberCountRef = useRef<null | number>(null);
    const noticeAccountRef = useRef('');

    useEffect(() => {
        if (hydrated && userId && sessionStorage.getItem(membershipKey) === account()) {
            void joinRoom().catch(report);
        }
    }, [hydrated, serverId, userId]);

    // 切换账号或服务器时重置提醒状态，避免跨账号误报
    useEffect(() => {
        const key = account();
        if (noticeAccountRef.current !== key) {
            noticeAccountRef.current = key;
            lastAnnouncementIdRef.current = null;
            prevMemberCountRef.current = null;
            suppressNextStartNotice = false;
        }
    }, [serverId, userId]);

    // 已加入房间时的高频播放同步轮询
    useEffect(() => {
        if (!member) return;
        if (member !== account()) {
            leaveRoom();
            return;
        }
        if (!serverId) return;
        const attachedDevice = device;
        let timer: ReturnType<typeof setTimeout>;
        let stopped = false;
        let lastSync = performance.now();
        let song: QueueSong | undefined;
        const active = () => !stopped && device === attachedDevice && member === account();
        const poll = async () => {
            try {
                const started = performance.now();
                let nextRoom = await siteApi.request<Room>(`/site/room?device=${attachedDevice}`);
                if (!active()) return;
                if (!nextRoom.joined) nextRoom = await requestRoom('join', {}, attachedDevice);
                if (!active()) return;
                const current = useRoom.getState().room;
                if (current?.session === nextRoom.session && current.version > nextRoom.version)
                    return;
                useRoom.setState({ error: '', room: nextRoom });
                const entry = nextRoom.queue[nextRoom.index];
                const transit = (performance.now() - started) / 2000;
                if (!entry || entry.unavailable) song = undefined;
                else if (song?._uniqueId !== entry.id) {
                    const item = await api.controller.getSongDetail({
                        apiClientProps: { serverId },
                        query: { id: entry.songId },
                    });
                    const latest = useRoom.getState().room;
                    if (
                        !active() ||
                        latest?.session !== nextRoom.session ||
                        latest.version !== nextRoom.version
                    )
                        return;
                    song = { ...item, _uniqueId: entry.id };
                }
                const position =
                    nextRoom.position +
                    (nextRoom.playing
                        ? (performance.now() - started) / 1000 -
                          transit +
                          (nextRoom.serverTime - nextRoom.updatedAt) / 1000
                        : 0);
                lastSync = performance.now();
                syncSharedSong(
                    song,
                    Math.min(entry?.duration ?? 0, Math.max(0, position)),
                    nextRoom.playing,
                );
            } catch (error) {
                if (!active()) return;
                if (!useRoom.getState().error) logger.warn('一起听同步失败', { error });
                useRoom.setState({ error: (error as Error).message });
                if (performance.now() - lastSync < 5000) return;
                const player = usePlayerStoreBase.getState();
                syncSharedSong(
                    player.getCurrentSong(),
                    useTimestampStoreBase.getState().timestamp,
                    false,
                );
            } finally {
                if (active()) timer = setTimeout(() => void poll(), 450);
            }
        };
        const disconnect = (event: PageTransitionEvent) => {
            if (!event.persisted)
                void requestRoom('leave', {}, attachedDevice).catch(() => undefined);
        };
        window.addEventListener('pagehide', disconnect);
        void poll();
        return () => {
            stopped = true;
            clearTimeout(timer);
            window.removeEventListener('pagehide', disconnect);
        };
    }, [member, serverId, userId]);

    // 未加入房间时的轻量预览轮询，供角标与提醒使用
    useEffect(() => {
        if (member || window.SERVER_NAME !== 'ndFork' || !userId || !serverId) {
            return;
        }
        let stopped = false;
        let timer: ReturnType<typeof setTimeout>;
        const pollPreview = async () => {
            try {
                const nextPreview = await siteApi.request<Room>('/site/room');
                if (!stopped) {
                    useRoom.setState({ preview: nextPreview });
                }
            } catch {
                // 预览轮询失败时保持静默，等待下一次重查
            } finally {
                if (!stopped) {
                    timer = setTimeout(() => void pollPreview(), 4000);
                }
            }
        };
        void pollPreview();
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    }, [member, serverId, userId]);

    // 处理开始一起听提醒与广播消息提醒
    useEffect(() => {
        if (window.SERVER_NAME !== 'ndFork' || !userId) return;
        const snapshot = member ? room : preview;
        if (!snapshot) return;

        const memberList = Object.values(snapshot.members);
        const memberCount = snapshot.memberCount;
        const previousCount = prevMemberCountRef.current;
        prevMemberCountRef.current = memberCount;

        if (!member) {
            if (suppressNextStartNotice) {
                suppressNextStartNotice = false;
            } else if (
                settings.notifyOnStart &&
                previousCount === 0 &&
                memberCount > 0 &&
                (memberCount > memberList.length || memberList.some((peer) => peer.id !== userId))
            ) {
                const names = memberList
                    .slice(0, 2)
                    .map((peer) => peer.name)
                    .join('、');
                const toastId = `room-start-${snapshot.session}-${snapshot.updatedAt}`;
                toast.info({
                    autoClose: 6000,
                    id: toastId,
                    message: (
                        <Group gap="xs" justify="space-between" wrap="nowrap">
                            <Text size="xs">{t(names ? 'together.startedNotice' : 'site.community.roomStarted', { names })}</Text>
                            <Button
                                onClick={() => {
                                    toast.hide(toastId);
                                    void joinRoom().catch(report);
                                }}
                                size="compact-xs"
                                variant="light"
                            >
                                {t('together.join')}
                            </Button>
                        </Group>
                    ),
                    title: t('site.listenTogether'),
                });
            }
        } else {
            suppressNextStartNotice = false;
        }

        const announcement = snapshot.announcement;
        if (announcement) {
            const isFirstRead = lastAnnouncementIdRef.current === null;
            const prevId = lastAnnouncementIdRef.current ?? 0;
            if (announcement.id > prevId) {
                lastAnnouncementIdRef.current = announcement.id;
                const isFresh =
                    snapshot.serverTime - announcement.createdAt <= STALE_ANNOUNCEMENT_MS;
                const fromOther = announcement.userId !== userId;
                if (settings.notifyOnBroadcast && fromOther && (!isFirstRead || isFresh)) {
                    const toastId = `room-broadcast-${announcement.id}`;
                    toast.info({
                        autoClose: 8000,
                        id: toastId,
                        message: (
                            <Group gap="xs" justify="space-between" wrap="nowrap">
                                <Text size="xs">
                                    {announcement.userName}：{announcement.message}
                                </Text>
                                {!member && (
                                    <Button
                                        onClick={() => {
                                            toast.hide(toastId);
                                            void joinRoom().catch(report);
                                        }}
                                        size="compact-xs"
                                        variant="light"
                                    >
                                        {t('together.join')}
                                    </Button>
                                )}
                            </Group>
                        ),
                        title: t('site.listenTogether'),
                    });
                }
            }
        }
    }, [member, preview, room, settings.notifyOnBroadcast, settings.notifyOnStart, t, userId]);

    useEffect(
        () =>
            useAuthStore.subscribe((state, previous) => {
                if (
                    useRoom.getState().member &&
                    (state.currentServer?.id !== previous.currentServer?.id ||
                        state.currentServer?.userId !== previous.currentServer?.userId)
                )
                    leaveRoom();
            }),
        [],
    );
    return null;
}

export async function roomCommand(action: string, body: Record<string, unknown> = {}) {
    const { member, room } = useRoom.getState();
    if (!member || member !== account() || !room) throw new Error(i18n.t('together.joinFirst'));
    const requestDevice = device;
    try {
        const next = await requestRoom(action, { session: room.session, ...body });
        const current = useRoom.getState().room;
        if (
            device === requestDevice &&
            current?.session === next.session &&
            next.version >= current.version
        ) {
            useRoom.setState({ room: next });
            const nextEntry = next.queue[next.index];
            const currentSong = usePlayerStoreBase.getState().getCurrentSong();
            if (nextEntry && !nextEntry.unavailable && currentSong?._uniqueId === nextEntry.id) {
                syncSharedSong(
                    currentSong,
                    Math.min(nextEntry.duration, Math.max(0, next.position)),
                    next.playing,
                    action === 'seek',
                );
            }
        }
        return next;
    } catch (error) {
        if (error instanceof SiteRoomConflict && device === requestDevice) {
            const current = useRoom.getState().room;
            if (
                current?.session === room.session &&
                (error.room.session !== current.session || error.room.version >= current.version)
            ) {
                useRoom.setState({ room: error.room });
            }
            throw new Error(i18n.t('together.changed'));
        }
        throw error;
    }
}

export default function RoomPage() {
    const { t } = useTranslation();
    return (
        <div className={siteStyles.page}>
            <Stack gap="lg">
                <LibraryHeaderBar>
                    <LibraryHeaderBar.Title>
                        <span className={styles.queuePanelTitle}>
                            <Icon icon="listenTogether" size="lg" />
                            {t('site.listenTogether')}
                        </span>
                    </LibraryHeaderBar.Title>
                </LibraryHeaderBar>
                <RoomContents />
            </Stack>
        </div>
    );
}

export function RoomPlayerButton({ position = 'top-end' }: { position?: 'top' | 'top-end' } = {}) {
    const { t } = useTranslation();
    const { activeCount, joined } = useRoomOverview();
    const [opened, setOpened] = useState(false);
    const [pinned, setPinned] = useState(false);
    const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => () => clearTimeout(hoverTimer.current), []);
    if (window.SERVER_NAME !== 'ndFork') return null;

    const close = () => {
        clearTimeout(hoverTimer.current);
        setOpened(false);
        setPinned(false);
    };
    const enter = (event: React.PointerEvent) => {
        if (event.pointerType !== 'mouse') return;
        clearTimeout(hoverTimer.current);
        if (!opened) hoverTimer.current = setTimeout(() => setOpened(true), 180);
    };
    const leave = (event: React.PointerEvent) => {
        if (event.pointerType !== 'mouse') return;
        clearTimeout(hoverTimer.current);
        if (!pinned) hoverTimer.current = setTimeout(close, 240);
    };

    return (
        <Popover
            offset={8}
            onChange={(value) => {
                if (!value) close();
            }}
            opened={opened}
            position={position}
            trapFocus={pinned}
            width="28rem"
        >
            <Popover.Target>
                <ActionIcon
                    aria-label={t('site.listenTogether')}
                    className={styles.trigger}
                    onClick={() => {
                        clearTimeout(hoverTimer.current);
                        if (pinned) close();
                        else {
                            setOpened(true);
                            setPinned(true);
                        }
                    }}
                    onPointerEnter={enter}
                    onPointerLeave={leave}
                    onKeyDown={(event) => {
                        if (event.key === 'Escape' && opened) {
                            event.stopPropagation();
                            close();
                        }
                    }}
                    size="sm"
                    stopsPropagation
                    variant="subtle"
                >
                    <Icon color={joined ? 'primary' : undefined} icon="listenTogether" size="lg" />
                    {activeCount > 0 && (
                        <span aria-hidden="true" className={styles.badge}>
                            {activeCount > 9 ? '9+' : activeCount}
                        </span>
                    )}
                </ActionIcon>
            </Popover.Target>
            <Popover.Dropdown
                className={styles.popoverDropdown}
                mah="calc(100dvh - 5rem)"
                onClick={(event) => event.stopPropagation()}
                onPointerEnter={enter}
                onPointerLeave={leave}
                p="lg"
            >
                <RoomContents compact onNavigate={close} />
            </Popover.Dropdown>
        </Popover>
    );
}

/** 共享队列基础列表：展示曲目详情，并仅在当前播放曲目下展示同步进度条与控制 */
export function RoomQueue({
    onNavigate,
    readOnly = false,
}: { onNavigate?: () => void; readOnly?: boolean } = {}) {
    const { t } = useTranslation();
    const room = useRoom((state) => (readOnly ? state.preview : state.room));
    const server = useAuthStore((state) => state.currentServer);
    const serverId = server?.id;
    const drag = useRef<null | { id: string; version: number }>(null);
    const list = useRef<HTMLOListElement>(null);
    const [pending, setPending] = useState<null | string>(null);
    if (!room) return null;
    const { queue, version } = room;
    const empty = queue.length === 0;
    const songs = queue
        .filter((entry) => !entry.unavailable)
        .map((entry) => ({ id: entry.songId }));
    const send = (action: string, body?: Record<string, unknown>) => {
        setPending(action);
        void roomCommand(action, body)
            .then(() => {
                if (action === 'saveQueue') toast.success({ message: t('form.saveQueue.success') });
            })
            .catch(report)
            .finally(() => setPending(null));
    };
    const actions = readOnly ? [] : [
        {
            action: 'import',
            disabled: false,
            icon: 'mediaPlayLast',
            label: t('queueImport.title'),
            run: () => {
                onNavigate?.();
                openImportQueueModal({
                    add: (songIds, skipDuplicates) =>
                        roomCommand('add', { skipDuplicates, songIds }),
                    songIds: () =>
                        useRoom.getState().room?.queue.map(({ songId }) => songId) ?? [],
                });
            },
        },
        {
            action: 'saveQueue',
            disabled: empty,
            icon: 'upload',
            label: t('player.saveQueueToServer'),
            run: () => send('saveQueue'),
        },
        {
            action: 'restoreQueue',
            disabled: false,
            icon: 'download',
            label: t('player.restoreQueueFromServer'),
            run: () => {
                const snapshot = useRoom.getState().room;
                const member = useRoom.getState().member;
                if (!snapshot) return;
                const restore = (overwrite: boolean) => {
                    const current = useRoom.getState();
                    if (current.member === member && current.room?.session === snapshot.session)
                        send('restoreQueue', { overwrite, version: snapshot.version });
                };
                if (snapshot.queue.length) confirmServerQueueRestore(true, () => restore(true));
                else restore(false);
            },
        },
        {
            action: 'playlist',
            disabled: songs.length === 0,
            icon: 'playlistAdd',
            label: t('action.createPlaylistFromQueue'),
            run: () => {
                onNavigate?.();
                openCreatePrefilledPlaylistModal(server ?? undefined, songs);
            },
        },
        {
            action: 'reorder',
            disabled: queue.length < 2,
            icon: 'mediaShuffle',
            label: t('player.shuffle'),
            run: () => send('reorder', { order: shuffle(queue.map((entry) => entry.id)), version }),
        },
        {
            action: 'current',
            disabled: empty,
            icon: 'goToItem',
            label: t('action.goToCurrent'),
            run: () =>
                list.current
                    ?.querySelector('[aria-current="true"]')
                    ?.scrollIntoView({ block: 'nearest' }),
        },
        {
            action: 'clearQueue',
            disabled: empty,
            icon: 'delete',
            label: t('action.clearQueue'),
            run: () => send('clearQueue'),
        },
    ] as const;

    return (
        <div className={styles.queueContent}>
            {!readOnly && (
                <Group
                    aria-label={t('together.queue')}
                    className={styles.queueToolbar}
                    gap="xs"
                    role="group"
                >
                    {actions.map(({ action, disabled, icon, label, run }) => (
                        <ActionIcon
                            aria-label={label}
                            disabled={disabled || pending !== null}
                            icon={icon}
                            key={action}
                            loading={pending === action}
                            onClick={run}
                            tooltip={{ label }}
                            variant="subtle"
                        />
                    ))}
                </Group>
            )}
            {empty && (
                <Text c="dimmed" px="xs" size="sm">
                    {t('site.emptyRoom')}
                </Text>
            )}
            <ol aria-label={t('together.queue')} className={styles.queue} ref={list}>
                {queue.map((entry, index) => {
                    const cover = !entry.unavailable
                        ? api.controller.getImageRequest({
                              apiClientProps: { serverId },
                              query: { id: entry.songId, itemType: LibraryItem.SONG, size: 96 },
                          })
                        : undefined;
                    const current = index === room.index;
                    const move = (offset: number) => {
                        const order = room.queue.map((song) => song.id);
                        [order[index], order[index + offset]] = [
                            order[index + offset],
                            order[index],
                        ];
                        void roomCommand('reorder', { order, version: room.version }).catch(report);
                    };
                    return (
                        <li
                            aria-current={current ? 'true' : undefined}
                            className={styles.entry}
                            key={entry.id}
                                onDragOver={(event) => {
                                if (drag.current) event.preventDefault();
                            }}
                            onDrop={(event) => {
                                const item = drag.current;
                                if (!item) return;
                                event.preventDefault();
                                drag.current = null;
                                const order = room.queue.map((song) => song.id);
                                const from = order.indexOf(item.id);
                                if (from < 0 || from === index) return;
                                order.splice(from, 1);
                                order.splice(index, 0, item.id);
                                void roomCommand('reorder', { order, version: item.version }).catch(
                                    report,
                                );
                            }}
                        >
                            {/* 仅曲目主信息行支持拖拽排序，避免与当前播放项的进度条拖拽冲突 */}
                            <div
                                className={styles.entryMain}
                                draggable={!readOnly}
                                onDragEnd={() => {
                                    drag.current = null;
                                }}
                                onDragStart={(event) => {
                                    drag.current = { id: entry.id, version: room.version };
                                    event.dataTransfer.setData('text/plain', entry.id);
                                    event.dataTransfer.effectAllowed = 'move';
                                }}
                            >
                                <Image
                                    alt=""
                                    containerClassName={styles.cover}
                                    imageRequest={cover ?? undefined}
                                    src={cover?.url}
                                />
                                <div className={styles.entryText}>
                                    <Text fw={current ? 700 : 500} size="sm" truncate>
                                        {entry.unavailable ? t('together.unavailable') : entry.name}
                                    </Text>
                                    <RoomEntryMeta entry={entry} onNavigate={onNavigate} />
                                </div>
                                {!readOnly && (
                                    <Group className={styles.entryActions} gap={2} wrap="nowrap">
                                        {!current && (
                                            <ActionIcon
                                                aria-label={t('site.play')}
                                                disabled={entry.unavailable}
                                                icon="mediaPlay"
                                                onClick={() =>
                                                    void roomCommand('select', {
                                                        entryId: entry.id,
                                                    }).catch(report)
                                                }
                                                size="sm"
                                                tooltip={{ label: t('site.play') }}
                                                variant="subtle"
                                            />
                                        )}
                                        <ActionIcon
                                            aria-label={t('together.moveUp')}
                                            disabled={index === 0}
                                            icon="arrowUp"
                                            onClick={() => move(-1)}
                                            size="sm"
                                            tooltip={{ label: t('together.moveUp') }}
                                            variant="subtle"
                                        />
                                        <ActionIcon
                                            aria-label={t('together.moveDown')}
                                            disabled={index === room.queue.length - 1}
                                            icon="arrowDown"
                                            onClick={() => move(1)}
                                            size="sm"
                                            tooltip={{ label: t('together.moveDown') }}
                                            variant="subtle"
                                        />
                                        <ActionIcon
                                            aria-label={t('site.delete')}
                                            icon="x"
                                            onClick={() =>
                                                void roomCommand('remove', { entryId: entry.id }).catch(
                                                    report,
                                                )
                                            }
                                            size="sm"
                                            tooltip={{ label: t('site.delete') }}
                                            variant="subtle"
                                        />
                                    </Group>
                                )}
                            </div>
                            {!readOnly && current && <RoomQueuePlayback entry={entry} room={room} />}
                        </li>
                    );
                })}
            </ol>
        </div>
    );
}

/** 单用户队列菜单顶部共存提示条：服务器有人在听时显示，方便快速加入 */
export function RoomQueueBanner({ onNavigate }: { onNavigate?: () => void } = {}) {
    const { t } = useTranslation();
    const { activeCount, busy, joined, onlineCount, snapshot } = useRoomOverview();
    if (window.SERVER_NAME !== 'ndFork' || joined || activeCount === 0) {
        return null;
    }
    const current = snapshot?.queue[snapshot.index];
    return (
        <div className={styles.coexistBanner}>
            <div className={styles.coexistBannerText}>
                <Icon icon="listenTogether" size="sm" />
                <Text size="xs" truncate>
                    {t('site.listenTogether')} ·{' '}
                    {t('together.onlineRatio', { members: activeCount, online: onlineCount })}
                    {current && !current.unavailable ? ` · ${current.name}` : ''}
                </Text>
            </div>
            <Group gap={4} wrap="nowrap">
                <ActionIcon
                    aria-label={t('together.details')}
                    component={Link}
                    icon="externalLink"
                    onClick={onNavigate}
                    size="xs"
                    to="/together"
                    tooltip={{ label: t('together.details') }}
                    variant="subtle"
                />
                <Button
                    leftSection={<Icon icon="signIn" size="xs" />}
                    loading={busy}
                    onClick={() => void joinRoom().catch(report)}
                    size="compact-xs"
                    variant="light"
                >
                    {t('together.join')}
                </Button>
            </Group>
        </div>
    );
}

/** 固定在播放队列菜单内的共享队列面板：保留外层容器与其他板块共存，替换单用户曲目列表 */
export function RoomQueuePanel({ onNavigate }: { onNavigate?: () => void } = {}) {
    const { t } = useTranslation();
    const { activeCount, error, onlineCount, room } = useRoomOverview();
    const [drawer, setDrawer] = useState<'broadcast' | 'search' | null>(null);
    const toggleDrawer = (target: 'broadcast' | 'search') =>
        setDrawer((prev) => (prev === target ? null : target));

    return (
        <div className={styles.queuePanel}>
            <div className={styles.queuePanelHeader}>
                <div className={styles.queuePanelTitle}>
                    <Icon color="primary" icon="queue" size="md" />
                    <Text fw={600} size="sm" truncate>
                        {t('together.queue')} ({room?.queue.length ?? 0})
                    </Text>
                    <span className={styles.navBadge}>
                        {t('together.onlineRatio', { members: activeCount, online: onlineCount })}
                    </span>
                </div>
                <Group gap="xs">
                    <ActionIcon
                        aria-label={t('together.search')}
                        icon="search"
                        iconProps={{ color: drawer === 'search' ? 'primary' : undefined }}
                        onClick={() => toggleDrawer('search')}
                        size="sm"
                        tooltip={{ label: t('together.search') }}
                        variant={drawer === 'search' ? 'light' : 'subtle'}
                    />
                    <ActionIcon
                        aria-label={t('together.broadcast')}
                        icon="bell"
                        iconProps={{ color: drawer === 'broadcast' ? 'primary' : undefined }}
                        onClick={() => toggleDrawer('broadcast')}
                        size="sm"
                        tooltip={{ label: t('together.broadcast') }}
                        variant={drawer === 'broadcast' ? 'light' : 'subtle'}
                    />
                    <ActionIcon
                        aria-label={t('together.settings')}
                        icon="settings2"
                        onClick={() => openRoomSettings(onNavigate)}
                        size="sm"
                        tooltip={{ label: t('together.settings') }}
                        variant="subtle"
                    />
                    <ActionIcon
                        aria-label={t('together.leave')}
                        icon="signOut"
                        onClick={leaveRoom}
                        size="sm"
                        tooltip={{ label: t('together.leave') }}
                        variant="subtle"
                    />
                </Group>
            </div>
            {error && (
                <div className={styles.queuePanelDrawer}>
                    <Text c="red" role="status" size="xs">
                        {t('together.reconnecting')} · {error}
                    </Text>
                </div>
            )}
            <AnimatePresence initial={false}>
                {drawer === 'search' && (
                    <motion.div
                        animate={{ height: 'auto', opacity: 1 }}
                        className={styles.queuePanelDrawer}
                        exit={{ height: 0, opacity: 0 }}
                        initial={{ height: 0, opacity: 0 }}
                        style={{ overflow: 'hidden' }}
                        transition={{ duration: 0.18, ease: 'easeOut' }}
                    >
                        <RoomSearchBox />
                    </motion.div>
                )}
                {drawer === 'broadcast' && (
                    <motion.div
                        animate={{ height: 'auto', opacity: 1 }}
                        className={styles.queuePanelDrawer}
                        exit={{ height: 0, opacity: 0 }}
                        initial={{ height: 0, opacity: 0 }}
                        style={{ overflow: 'hidden' }}
                        transition={{ duration: 0.18, ease: 'easeOut' }}
                    >
                        <RoomBroadcastForm />
                    </motion.div>
                )}
            </AnimatePresence>
            <div className={styles.queuePanelBody}>
                <RoomQueue onNavigate={onNavigate} />
            </div>
        </div>
    );
}

export function useRoomActive() {
    return useRoom((state) => Boolean(state.member));
}

/** 共享房间概览状态，供状态栏按钮、侧边栏导航与队列横条共用 */
export function useRoomOverview() {
    const busy = useRoom((state) => state.busy);
    const error = useRoom((state) => state.error);
    const member = useRoom((state) => state.member);
    const room = useRoom((state) => state.room);
    const preview = useRoom((state) => state.preview);

    const joined = Boolean(member);
    const snapshot = joined ? room : preview;
    const activeCount = snapshot?.memberCount ?? 0;
    return {
        activeCount,
        busy,
        error,
        joined,
        onlineCount: snapshot?.onlineCount ?? activeCount,
        preview,
        room,
        snapshot,
    };
}

function dispatchPlayerCommand(command: SharedPlaybackCommand) {
    const room = useRoom.getState().room;
    const entry = room?.queue[room.index];
    if (command.action === 'add') {
        const songIds = command.songs?.map((song) => song.id) ?? [];
        if (!songIds.length) return true;
        const now = command.playType === Play.NOW || command.playType === Play.SHUFFLE;
        const next = command.playType === Play.NEXT || command.playType === Play.NEXT_SHUFFLE;
        if (
            command.playType === Play.SHUFFLE ||
            command.playType === Play.NEXT_SHUFFLE ||
            command.playType === Play.LAST_SHUFFLE
        ) {
            for (let index = songIds.length - 1; index > 0; index--) {
                const other = Math.floor(Math.random() * (index + 1));
                [songIds[index], songIds[other]] = [songIds[other], songIds[index]];
            }
        }
        void roomCommand(now ? 'addNow' : next ? 'addNext' : 'add', {
            edge: command.edge,
            entryId: command.anchorId,
            playSongId: command.playSongId,
            songIds,
        }).catch(report);
    } else if (command.action === 'seek' && entry && !entry.unavailable) {
        void roomCommand('seek', {
            entryId: entry.id,
            position: Math.min(entry.duration, command.position ?? 0),
        }).catch(report);
    } else if (command.action === 'select' && entry) {
        if (command.index === 0 && !entry.unavailable)
            void roomCommand('select', { entryId: entry.id }).catch(report);
    } else if (command.action !== 'seek' && command.action !== 'select') {
        void roomCommand(command.action).catch(report);
    }
    return true;
}

function formatClock(seconds: number) {
    return formatDuration(Math.max(0, seconds) * 1000 || 0);
}

async function joinRoom() {
    const member = account();
    if (!member || useRoom.getState().busy || useRoom.getState().member) return;
    useRoom.setState({ busy: true });
    try {
        const joiningDevice = nanoid();
        const room = await requestRoom('join', {}, joiningDevice);
        if (member !== account()) return;
        device = joiningDevice;
        sessionStorage.setItem(membershipKey, member);
        useRoom.setState({ error: '', member, preview: room, room });
        beginSharedPlayback(dispatchPlayerCommand);
    } finally {
        useRoom.setState({ busy: false });
    }
}

function leaveRoom() {
    const leavingDevice = device;
    const restore = useRoom.getState().member === account();
    const hadOthers = Object.keys(useRoom.getState().room?.members ?? {}).length > 1;
    if (hadOthers) {
        suppressNextStartNotice = true;
    }
    device = '';
    sessionStorage.removeItem(membershipKey);
    useRoom.setState({ error: '', member: '', preview: null, room: null });
    endSharedPlayback(restore);
    if (restore) void requestRoom('leave', {}, leavingDevice).catch(() => undefined);
}

function openRoomSettings(onNavigate?: () => void) {
    onNavigate?.();
    useSettingsStore.getState().actions.setSettings({ tab: 'general' });
    openSettingsModal();
}

function report(error: Error) {
    toast.error({ message: error.message });
}

async function requestRoom(
    action: string,
    body: Record<string, unknown> = {},
    requestDevice = device,
): Promise<Room> {
    const server = useAuthStore.getState().currentServer;
    const response = await fetch(`${server?.url || window.SERVER_URL}/site/room`, {
        body: JSON.stringify({ action, device: requestDevice, ...body }),
        credentials: 'include',
        headers: {
            'Content-Type': 'application/json',
            ...(server?.ndCredential && { 'x-nd-authorization': `Bearer ${server.ndCredential}` }),
        },
        keepalive: action === 'leave',
        method: 'POST',
    });
    if (response.status === 204) return undefined as never;
    const data = await response.json();
    if (action === 'restoreQueue' && response.status === 404) {
        throw new Error(i18n.t('together.noSavedQueue'));
    }
    if (response.status === 409 && data.session) throw new SiteRoomConflict(data);
    if (!response.ok) throw new Error(data.message || response.statusText);
    return data;
}

/** 房间广播发送栏：向站内在线用户发送一起听提醒 */
function RoomBroadcastForm() {
    const { t } = useTranslation();
    const [message, setMessage] = useState('');
    const [sending, setSending] = useState(false);

    const submit = () => {
        if (sending) return;
        const text = message.trim() || t('together.defaultBroadcast');
        setSending(true);
        void roomCommand('announce', { message: text })
            .then(() => {
                setMessage('');
                toast.success({ message: t('together.broadcastSent') });
            })
            .catch(report)
            .finally(() => setSending(false));
    };

    return (
        <Group gap="xs" wrap="nowrap">
            <TextInput
                aria-label={t('together.broadcast')}
                leftSection={<Icon icon="bell" size="xs" />}
                maxLength={120}
                onChange={(event) => setMessage(event.currentTarget.value)}
                onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        submit();
                    }
                }}
                placeholder={t('together.broadcastPlaceholder')}
                size="xs"
                style={{ flex: 1, minWidth: 0 }}
                value={message}
            />
            <Button
                leftSection={<Icon icon="bell" size="xs" />}
                loading={sending}
                onClick={submit}
                size="compact-xs"
                variant="light"
            >
                {t('together.send')}
            </Button>
        </Group>
    );
}

function RoomContents({ compact, onNavigate }: { compact?: boolean; onNavigate?: () => void }) {
    const { t } = useTranslation();
    const { activeCount, busy, error, joined, onlineCount, snapshot } = useRoomOverview();
    const selected = usePlayerSong();
    const serverId = useAuthStore((state) => state.currentServer?.id);
    const current = snapshot?.queue[snapshot.index];
    const next = snapshot?.queue[snapshot.index + 1];
    const roomStatus =
        activeCount === 0
            ? 'together.roomIdle'
            : snapshot?.playing
              ? 'together.roomPlaying'
              : current
                ? 'together.roomPaused'
                : 'together.roomWaiting';
    const livePosition = useSyncedRoomPosition(current, snapshot?.position ?? 0, joined);
    const seek = useRoomSeek(current, livePosition);
    const cover =
        current && !current.unavailable
            ? api.controller.getImageRequest({
                  apiClientProps: { serverId },
                  query: { id: current.songId, itemType: LibraryItem.SONG, size: 96 },
              })
            : undefined;
    return (
        <Stack gap="lg">
            <Group className={styles.overviewHeader} gap="sm" justify="space-between">
                <Group gap="sm" wrap="nowrap">
                    <Icon color={joined ? 'primary' : undefined} icon="listenTogether" size="lg" />
                    <Text c="dimmed" size="sm">
                        {t(joined ? 'together.sharedMode' : 'together.personalMode')}
                        {snapshot && ` · ${t(roomStatus)}`}
                    </Text>
                </Group>
                <Group gap="xs">
                    <ActionIcon
                        aria-label={t('together.settings')}
                        icon="settings2"
                        onClick={() => openRoomSettings(onNavigate)}
                        size="sm"
                        tooltip={{ label: t('together.settings') }}
                        variant="subtle"
                    />
                    <Button
                        leftSection={<Icon icon={joined ? 'signOut' : 'signIn'} size="xs" />}
                        loading={busy}
                        onClick={() => (joined ? leaveRoom() : void joinRoom().catch(report))}
                        size="compact-sm"
                        variant={joined ? 'light' : 'filled'}
                    >
                        {t(joined ? 'together.leave' : 'together.join')}
                    </Button>
                </Group>
            </Group>
            {error && (
                <Text c="red" role="status" size="sm">
                    {t('together.reconnecting')} · {error}
                </Text>
            )}
            {current && (
                <Stack className={styles.overviewCard} gap="sm">
                    <Group gap="sm" wrap="nowrap">
                        {cover && (
                            <Image
                                alt=""
                                containerClassName={styles.cover}
                                imageRequest={cover}
                                src={cover.url}
                            />
                        )}
                        <Stack className={styles.entryText} gap={0}>
                            <Text fw={700} truncate>
                                {current.unavailable ? t('together.unavailable') : current.name}
                            </Text>
                            <RoomEntryMeta entry={current} onNavigate={onNavigate} />
                        </Stack>
                        <Text c="dimmed" className={styles.time} size="xs">
                            {formatClock(seek.displayedPosition)} / {formatClock(current.duration)}
                        </Text>
                    </Group>
                    {next && (
                        <Group gap="xs" wrap="nowrap">
                            <Icon icon="mediaNext" size="xs" />
                            <Text c="dimmed" size="sm" truncate>
                                {t('site.next')}: {next.unavailable ? t('together.unavailable') : next.name}
                            </Text>
                        </Group>
                    )}
                    {joined && (
                        <>
                            <Slider
                                aria-label={t('together.progress')}
                                disabled={current.unavailable}
                                key={current.id}
                                label={(value) => formatClock(value)}
                                max={Math.max(current.duration, 0.1)}
                                onChange={seek.onChange}
                                onChangeEnd={seek.onChangeEnd}
                                step={0.1}
                                value={seek.displayedPosition}
                            />
                            <Group gap="xs" justify="center">
                                <Button
                                    leftSection={<Icon icon="mediaPrevious" size="xs" />}
                                    onClick={() => void roomCommand('previous').catch(report)}
                                    size="compact-sm"
                                    variant="subtle"
                                >
                                    {t('player.previous')}
                                </Button>
                                <Button
                                    leftSection={
                                        <Icon icon={snapshot?.playing ? 'mediaPause' : 'mediaPlay'} size="xs" />
                                    }
                                    onClick={() =>
                                        void roomCommand(
                                            snapshot?.playing ? 'pause' : 'play',
                                        ).catch(report)
                                    }
                                    size="compact-sm"
                                >
                                    {t(snapshot?.playing ? 'site.pause' : 'site.play')}
                                </Button>
                                <Button
                                    leftSection={<Icon icon="mediaNext" size="xs" />}
                                    onClick={() => void roomCommand('next').catch(report)}
                                    size="compact-sm"
                                    variant="subtle"
                                >
                                    {t('site.next')}
                                </Button>
                            </Group>
                        </>
                    )}
                </Stack>
            )}
            {joined && !compact && (
                <Stack className={styles.overviewCard} gap="xs">
                    <Group gap="xs" wrap="nowrap">
                        <Icon icon="bell" size="sm" />
                        <Text fw={600} size="sm">{t('together.broadcast')}</Text>
                    </Group>
                    <RoomBroadcastForm />
                </Stack>
            )}
            {!compact && snapshot && (joined || snapshot.queue.length > 0) && (
                <Stack className={styles.overviewCard} gap="sm">
                    <Group gap="xs" wrap="nowrap">
                        <Icon icon="queue" size="sm" />
                        <Text fw={600}>
                            {t('together.queue')} ({snapshot.queue.length})
                        </Text>
                    </Group>
                    {joined && <RoomSearchBox />}
                    {joined && !current && selected && (
                        <Button
                            leftSection={<Icon icon="playlistAdd" size="xs" />}
                            onClick={() =>
                                void roomCommand('add', { songIds: [selected.id] }).catch(report)
                            }
                            variant="light"
                        >
                            {t('site.addCurrent')}
                        </Button>
                    )}
                    <RoomQueue onNavigate={onNavigate} readOnly={!joined} />
                </Stack>
            )}
            {snapshot && (
                <RoomMembers
                    memberCount={snapshot.memberCount}
                    members={snapshot.members}
                    onlineCount={onlineCount}
                    serverTime={snapshot.serverTime}
                />
            )}
            {compact && (
                <Group justify="flex-end">
                    <Button
                        component={Link}
                        leftSection={<Icon icon="externalLink" size="xs" />}
                        onClick={onNavigate}
                        size="compact-sm"
                        to="/together"
                        variant="subtle"
                    >
                        {t('together.details')}
                    </Button>
                </Group>
            )}
        </Stack>
    );
}

/** 共享队列曲目详情：歌手、专辑链接及由时长、年份、点歌人组成的元信息 */
function RoomEntryMeta({ entry, onNavigate }: { entry: Entry; onNavigate?: () => void }) {
    const { t } = useTranslation();
    if (entry.unavailable) {
        return (
            <Text c="dimmed" className={styles.meta} size="xs" truncate>
                {formatClock(entry.duration)}
            </Text>
        );
    }

    const details = [
        formatClock(entry.duration),
        entry.year ? String(entry.year) : '',
        entry.addedBy ? t('together.addedBy', { name: entry.addedBy }) : '',
    ]
        .filter(Boolean)
        .join(' · ');

    return (
        <>
            {(entry.artist || entry.album) && (
                <Text c="dimmed" size="xs" truncate>
                    {entry.artistId ? (
                        <Link
                            className={styles.link}
                            onClick={onNavigate}
                            to={generatePath(AppRoute.LIBRARY_ALBUM_ARTISTS_DETAIL, {
                                albumArtistId: entry.artistId,
                            })}
                        >
                            {entry.artist}
                        </Link>
                    ) : (
                        entry.artist
                    )}
                    {entry.artist && entry.album ? ' · ' : ''}
                    {entry.album &&
                        (entry.albumId ? (
                            <Link
                                className={styles.link}
                                onClick={onNavigate}
                                to={generatePath(AppRoute.LIBRARY_ALBUMS_DETAIL, {
                                    albumId: entry.albumId,
                                })}
                            >
                                {entry.album}
                            </Link>
                        ) : (
                            entry.album
                        ))}
                </Text>
            )}
            <Text c="dimmed" className={styles.meta} size="xs" truncate>
                {details}
            </Text>
        </>
    );
}

/** 共享队列当前播放曲目的同步进度条与控制栏 */
function RoomQueuePlayback({ entry, room }: { entry: Entry; room: Room }) {
    const { t } = useTranslation();
    const livePosition = useSyncedRoomPosition(entry, room.position, true);
    const seek = useRoomSeek(entry, livePosition);

    return (
        <div className={styles.playback}>
            <div className={styles.progressRow}>
                <Text c="dimmed" className={styles.time} size="xs">
                    {formatClock(seek.displayedPosition)}
                </Text>
                <div className={styles.sliderWrap}>
                    <Slider
                        aria-label={t('together.progress')}
                        disabled={entry.unavailable}
                        label={(value) => formatClock(value)}
                        max={Math.max(entry.duration, 0.1)}
                        min={0}
                        onChange={seek.onChange}
                        onChangeEnd={seek.onChangeEnd}
                        size="sm"
                        step={0.1}
                        value={seek.displayedPosition}
                    />
                </div>
                <Text c="dimmed" className={styles.time} size="xs">
                    {formatClock(entry.duration)}
                </Text>
            </div>
            <Group gap="xs" justify="center" wrap="nowrap">
                <ActionIcon
                    aria-label={t('player.previous')}
                    icon="mediaPrevious"
                    onClick={() => void roomCommand('previous').catch(report)}
                    size="sm"
                    tooltip={{ label: t('player.previous') }}
                    variant="subtle"
                />
                <ActionIcon
                    aria-label={t(room.playing ? 'site.pause' : 'site.play')}
                    icon={room.playing ? 'mediaPause' : 'mediaPlay'}
                    onClick={() => void roomCommand(room.playing ? 'pause' : 'play').catch(report)}
                    size="sm"
                    tooltip={{ label: t(room.playing ? 'site.pause' : 'site.play') }}
                    variant="light"
                />
                <ActionIcon
                    aria-label={t('site.next')}
                    icon="mediaNext"
                    onClick={() => void roomCommand('next').catch(report)}
                    size="sm"
                    tooltip={{ label: t('site.next') }}
                    variant="subtle"
                />
            </Group>
        </div>
    );
}

/** 共享队列点歌搜索框 */
function RoomSearchBox() {
    const { t } = useTranslation();
    const serverId = useAuthStore((state) => state.currentServer?.id);
    const [search, setSearch] = useState('');
    const [term] = useDebouncedValue(search.trim(), 250);
    const results = useQuery(
        searchQueries.search({
            options: { enabled: Boolean(term) },
            query: { albumArtistLimit: 0, albumLimit: 0, query: term, songLimit: 12 },
            serverId: serverId ?? '',
        }),
    );

    return (
        <Stack gap="xs">
            <TextInput
                aria-label={t('together.search')}
                leftSection={<Icon icon="search" size="xs" />}
                onChange={(event) => setSearch(event.currentTarget.value)}
                placeholder={t('together.search')}
                size="xs"
                value={search}
            />
            {term && results.isFetching && (
                <Text c="dimmed" size="xs">
                    {t('together.searching')}
                </Text>
            )}
            {term && results.isError && (
                <Text c="red" role="status" size="xs">
                    {results.error.message}
                </Text>
            )}
            {term && results.data?.songs.length === 0 && (
                <Text c="dimmed" size="xs">
                    {t('together.noResults')}
                </Text>
            )}
            {term &&
                results.data?.songs.map((song) => (
                    <Group gap="xs" key={song.id} wrap="nowrap">
                        <Text className={styles.entryText} size="xs" truncate>
                            {song.name} · {song.artistName}
                        </Text>
                        <Button
                            leftSection={<Icon icon="plus" size="xs" />}
                            onClick={() =>
                                void roomCommand('add', { songIds: [song.id] }).catch(report)
                            }
                            size="compact-xs"
                            variant="light"
                        >
                            {t('together.add')}
                        </Button>
                        <Button
                            leftSection={<Icon icon="mediaPlayNext" size="xs" />}
                            onClick={() =>
                                void roomCommand('addNext', { songIds: [song.id] }).catch(report)
                            }
                            size="compact-xs"
                            variant="subtle"
                        >
                            {t('together.addNext')}
                        </Button>
                    </Group>
                ))}
        </Stack>
    );
}

/** 共享播放进度条拖拽状态，避免等待服务端确认期间进度条回弹 */
function useRoomSeek(entry: Entry | undefined, livePosition: number) {
    const [seekingPosition, setSeekingPosition] = useState<null | number>(null);
    const releasedAtRef = useRef<null | number>(null);

    useEffect(() => {
        setSeekingPosition(null);
        releasedAtRef.current = null;
    }, [entry?.id]);

    useEffect(() => {
        if (seekingPosition === null || releasedAtRef.current === null) return;
        const closeEnough = Math.abs(livePosition - seekingPosition) < 0.5;
        const timedOut = Date.now() - releasedAtRef.current > SEEK_RESOLVE_MS;
        if (closeEnough || timedOut) {
            setSeekingPosition(null);
            releasedAtRef.current = null;
        }
    }, [livePosition, seekingPosition]);

    return {
        displayedPosition: seekingPosition ?? livePosition,
        onChange: (value: number) => {
            releasedAtRef.current = null;
            setSeekingPosition(value);
        },
        onChangeEnd: (value: number) => {
            if (!entry) return;
            setSeekingPosition(value);
            if (Math.abs(livePosition - value) < 0.5) {
                setSeekingPosition(null);
                releasedAtRef.current = null;
            } else {
                releasedAtRef.current = Date.now();
            }
            void roomCommand('seek', {
                entryId: entry.id,
                position: value,
            }).catch(report);
        },
    };
}

/** 共享播放进度读取，已加入房间且曲目匹配时与本地播放器时间轴保持同步 */
function useSyncedRoomPosition(
    entry: Entry | undefined,
    fallbackPosition: number,
    activeMember: boolean,
) {
    const playerSong = usePlayerSong();
    const playerTimestamp = usePlayerTimestamp();
    const duration = entry?.duration ?? 0;
    const synced = activeMember && Boolean(entry) && playerSong?._uniqueId === entry?.id;
    const raw = synced ? playerTimestamp : fallbackPosition;
    return Math.min(duration, Math.max(0, raw));
}
