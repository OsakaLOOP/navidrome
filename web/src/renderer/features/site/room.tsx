import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { generatePath, Link } from 'react-router';
import { createWithEqualityFn } from 'zustand/traditional';

import styles from './room.module.css';
import { siteApi } from './site-api';
import siteStyles from './site.module.css';

import i18n from '/@/i18n/i18n';
import { api } from '/@/renderer/api';
import { searchQueries } from '/@/renderer/features/search/api/search-api';
import { LibraryHeaderBar } from '/@/renderer/features/shared/components/library-header-bar';
import { AppRoute } from '/@/renderer/router/routes';
import { useAuthStore, usePlayerSong } from '/@/renderer/store';
import {
    beginSharedPlayback,
    endSharedPlayback,
    SharedPlaybackCommand,
    syncSharedSong,
    usePlayerStoreBase,
} from '/@/renderer/store/player.store';
import { useTimestampStoreBase } from '/@/renderer/store/timestamp.store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Button } from '/@/shared/components/button/button';
import { Group } from '/@/shared/components/group/group';
import { Image } from '/@/shared/components/image/image';
import { Modal } from '/@/shared/components/modal/modal';
import { Slider } from '/@/shared/components/slider/slider';
import { Stack } from '/@/shared/components/stack/stack';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { Text } from '/@/shared/components/text/text';
import { toast } from '/@/shared/components/toast/toast';
import { useDebouncedValue } from '/@/shared/hooks/use-debounced-value';
import { LibraryItem, QueueSong } from '/@/shared/types/domain-types';
import { Play } from '/@/shared/types/types';

type Entry = {
    addedBy: string;
    albumId: string;
    artist: string;
    artistId: string;
    duration: number;
    id: string;
    name: string;
    songId: string;
};

type Room = {
    index: number;
    joined: boolean;
    members: Record<string, { devices: number; id: string; name: string }>;
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
    room: null | Room;
}>(() => ({ busy: false, error: '', member: '', room: null }));
let device = '';

class SiteRoomConflict extends Error {
    constructor(public room: Room) {
        super('409');
    }
}

export function isRoomActive() {
    return Boolean(useRoom.getState().member);
}

export function RoomBridge() {
    const member = useRoom((state) => state.member);
    const serverId = useAuthStore((state) => state.currentServer?.id);
    const userId = useAuthStore((state) => state.currentServer?.userId);
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
        let song: QueueSong | undefined;
        const active = () => !stopped && device === attachedDevice && member === account();
        const poll = async () => {
            try {
                const started = performance.now();
                let room = await siteApi.request<Room>(`/site/room?device=${attachedDevice}`);
                if (!active()) return;
                if (!room.joined) room = await requestRoom('join', {}, attachedDevice);
                if (!active()) return;
                const current = useRoom.getState().room;
                if (current?.session === room.session && current.version > room.version) return;
                useRoom.setState({ error: '', room });
                const entry = room.queue[room.index];
                const transit = (performance.now() - started) / 2000;
                if (!entry) song = undefined;
                else if (song?._uniqueId !== entry.id) {
                    const item = await api.controller.getSongDetail({
                        apiClientProps: { serverId },
                        query: { id: entry.songId },
                    });
                    if (
                        !active() ||
                        useRoom.getState().room?.queue[useRoom.getState().room!.index]?.id !==
                            entry.id
                    )
                        return;
                    song = { ...item, _uniqueId: entry.id };
                }
                const position =
                    room.position +
                    (room.playing ? transit + (room.serverTime - room.updatedAt) / 1000 : 0);
                syncSharedSong(song, Math.min(entry?.duration ?? 0, position), room.playing);
            } catch (error) {
                if (!active()) return;
                useRoom.setState({ error: (error as Error).message });
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
        void poll();
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    }, [member, serverId, userId]);
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
        )
            useRoom.setState({ room: next });
        return next;
    } catch (error) {
        if (error instanceof SiteRoomConflict && device === requestDevice) {
            useRoom.setState({ room: error.room });
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
                    <LibraryHeaderBar.Title>{t('site.listenTogether')}</LibraryHeaderBar.Title>
                </LibraryHeaderBar>
                <RoomContents />
            </Stack>
        </div>
    );
}

export function RoomPlayerButton() {
    const { t } = useTranslation();
    const joined = useRoomActive();
    const status = useRoom((state) =>
        state.error ? 'reconnecting' : state.room?.playing ? 'playing' : 'paused',
    );
    const [opened, setOpened] = useState(false);
    if (window.SERVER_NAME !== 'ndFork') return null;
    const label = joined
        ? `${t('site.listenTogether')} · ${t(`together.${status}`)}`
        : t('site.listenTogether');
    return (
        <>
            <ActionIcon
                aria-label={label}
                aria-pressed={joined}
                icon="group"
                onClick={() => setOpened(true)}
                stopsPropagation
                tooltip={{ label }}
                variant={joined ? 'light' : 'subtle'}
            />
            <Modal
                handlers={{
                    close: () => setOpened(false),
                    open: () => setOpened(true),
                    toggle: () => setOpened(!opened),
                }}
                opened={opened}
                size="lg"
                title={label}
            >
                <RoomContents compact onNavigate={() => setOpened(false)} />
            </Modal>
        </>
    );
}

export function RoomQueue() {
    const { t } = useTranslation();
    const room = useRoom((state) => state.room);
    const serverId = useAuthStore((state) => state.currentServer?.id);
    if (!room?.queue.length)
        return (
            <Text c="dimmed" size="sm">
                {t('site.emptyRoom')}
            </Text>
        );
    return (
        <ol aria-label={t('together.queue')} className={styles.queue}>
            {room.queue.map((entry, index) => {
                const cover = api.controller.getImageRequest({
                    apiClientProps: { serverId },
                    query: { id: entry.songId, itemType: LibraryItem.SONG, size: 96 },
                });
                const current = index === room.index;
                const move = (offset: number) => {
                    const order = room.queue.map((song) => song.id);
                    [order[index], order[index + offset]] = [order[index + offset], order[index]];
                    void roomCommand('reorder', { order, version: room.version }).catch(report);
                };
                return (
                    <li
                        aria-current={current ? 'true' : undefined}
                        className={styles.entry}
                        key={entry.id}
                    >
                        <Image
                            alt=""
                            containerClassName={styles.cover}
                            imageRequest={cover ?? undefined}
                            src={cover?.url}
                        />
                        <div className={styles.entryText}>
                            <Text fw={current ? 700 : 500} size="sm" truncate>
                                {entry.name}
                            </Text>
                            <Text c="dimmed" size="xs" truncate>
                                {entry.artistId ? (
                                    <Link
                                        to={generatePath(AppRoute.LIBRARY_ALBUM_ARTISTS_DETAIL, {
                                            albumArtistId: entry.artistId,
                                        })}
                                    >
                                        {entry.artist}
                                    </Link>
                                ) : (
                                    entry.artist
                                )}
                                {' · '}
                                {t('together.addedBy', { name: entry.addedBy })}
                            </Text>
                        </div>
                        <Group gap={3} wrap="nowrap">
                            <ActionIcon
                                aria-label={t('site.play')}
                                icon="mediaPlay"
                                onClick={() =>
                                    void roomCommand('select', { entryId: entry.id }).catch(report)
                                }
                                tooltip={{ label: t('site.play') }}
                                variant="subtle"
                            />
                            <ActionIcon
                                aria-label={t('together.moveUp')}
                                disabled={index === 0}
                                icon="arrowUp"
                                onClick={() => move(-1)}
                                tooltip={{ label: t('together.moveUp') }}
                                variant="subtle"
                            />
                            <ActionIcon
                                aria-label={t('together.moveDown')}
                                disabled={index === room.queue.length - 1}
                                icon="arrowDown"
                                onClick={() => move(1)}
                                tooltip={{ label: t('together.moveDown') }}
                                variant="subtle"
                            />
                            <ActionIcon
                                aria-label={t('site.delete')}
                                icon="x"
                                onClick={() =>
                                    void roomCommand('remove', { entryId: entry.id }).catch(report)
                                }
                                tooltip={{ label: t('site.delete') }}
                                variant="subtle"
                            />
                        </Group>
                    </li>
                );
            })}
        </ol>
    );
}

export function useRoomActive() {
    return useRoom((state) => Boolean(state.member));
}

function dispatchPlayerCommand(command: SharedPlaybackCommand) {
    const room = useRoom.getState().room;
    const entry = room?.queue[room.index];
    if (command.action === 'add') {
        const action =
            command.playType === Play.NEXT || command.playType === Play.NEXT_SHUFFLE
                ? 'addNext'
                : 'add';
        void roomCommand(action, { songIds: command.songs?.map((song) => song.id) }).catch(report);
    } else if (command.action === 'seek' && entry) {
        void roomCommand('seek', {
            entryId: entry.id,
            position: Math.min(entry.duration, command.position ?? 0),
        }).catch(report);
    } else if (command.action === 'select' && entry) {
        if (command.index === 0) void roomCommand('select', { entryId: entry.id }).catch(report);
    } else if (command.action !== 'seek' && command.action !== 'select') {
        void roomCommand(command.action).catch(report);
    }
    return true;
}

async function joinRoom() {
    const member = account();
    if (!member || useRoom.getState().busy || useRoom.getState().member) return;
    useRoom.setState({ busy: true });
    const joiningDevice = crypto.randomUUID();
    try {
        const room = await requestRoom('join', {}, joiningDevice);
        if (member !== account()) return;
        device = joiningDevice;
        beginSharedPlayback(dispatchPlayerCommand);
        useRoom.setState({ error: '', member, room });
    } finally {
        useRoom.setState({ busy: false });
    }
}

function leaveRoom() {
    const leavingDevice = device;
    const restore = useRoom.getState().member === account();
    device = '';
    useRoom.setState({ error: '', member: '', room: null });
    endSharedPlayback(restore);
    if (restore) void requestRoom('leave', {}, leavingDevice).catch(() => undefined);
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
    if (response.status === 409 && data.session) throw new SiteRoomConflict(data);
    if (!response.ok) throw new Error(data.message || response.statusText);
    return data;
}

function RoomContents({ compact, onNavigate }: { compact?: boolean; onNavigate?: () => void }) {
    const { t } = useTranslation();
    const { busy, error, member, room } = useRoom();
    const selected = usePlayerSong();
    const serverId = useAuthStore((state) => state.currentServer?.id);
    const userId = useAuthStore((state) => state.currentServer?.userId);
    const [search, setSearch] = useState('');
    const [term] = useDebouncedValue(search.trim(), 250);
    const [position, setPosition] = useState<null | number>(null);
    const preview = useQuery({
        enabled: !member && Boolean(userId),
        queryFn: () => siteApi.request<Room>('/site/room'),
        queryKey: ['site', 'room', serverId, userId],
        refetchInterval: 5000,
    });
    const results = useQuery(
        searchQueries.search({
            options: { enabled: Boolean(member && term) },
            query: { albumArtistLimit: 0, albumLimit: 0, query: term, songLimit: 12 },
            serverId: serverId ?? '',
        }),
    );
    const state = member ? room : preview.data;
    const current = state?.queue[state.index];
    const next = state?.queue[state.index + 1];
    return (
        <Stack gap="md">
            <Group justify="space-between">
                <Text c="dimmed" size="sm">
                    {t(member ? 'together.sharedMode' : 'together.personalMode')}
                </Text>
                <Group gap="xs">
                    {compact && (
                        <Button
                            component={Link}
                            onClick={onNavigate}
                            size="compact-sm"
                            to="/together"
                            variant="subtle"
                        >
                            {t('together.details')}
                        </Button>
                    )}
                    <Button
                        loading={busy}
                        onClick={() => (member ? leaveRoom() : void joinRoom().catch(report))}
                        size="compact-sm"
                        variant={member ? 'light' : 'filled'}
                    >
                        {t(member ? 'together.leave' : 'site.joinRoom')}
                    </Button>
                </Group>
            </Group>
            {(error || preview.isError) && (
                <Text c="red" role="status" size="sm">
                    {error ? `${t('together.reconnecting')} · ${error}` : preview.error?.message}
                </Text>
            )}
            {!member && !compact && (
                <Text c="dimmed" size="sm">
                    {t('together.help')}
                </Text>
            )}
            {current && (
                <Stack gap="xs">
                    <Text fw={700} truncate>
                        {current.name} · {current.artist}
                    </Text>
                    <Text c="dimmed" size="sm" truncate>
                        {t(state?.playing ? 'together.playing' : 'together.paused')}
                        {next ? ` · ${t('site.next')}: ${next.name}` : ''}
                    </Text>
                    {member && (
                        <>
                            <Slider
                                aria-label={t('together.progress')}
                                key={current.id}
                                max={current.duration}
                                onChange={setPosition}
                                onChangeEnd={(value) => {
                                    setPosition(null);
                                    void roomCommand('seek', {
                                        entryId: current.id,
                                        position: value,
                                    }).catch(report);
                                }}
                                step={0.1}
                                value={position ?? state?.position ?? 0}
                            />
                            <Group gap="xs">
                                <Button
                                    onClick={() => void roomCommand('previous').catch(report)}
                                    size="compact-sm"
                                    variant="subtle"
                                >
                                    {t('player.previous')}
                                </Button>
                                <Button
                                    onClick={() =>
                                        void roomCommand(state?.playing ? 'pause' : 'play').catch(
                                            report,
                                        )
                                    }
                                    size="compact-sm"
                                >
                                    {t(state?.playing ? 'site.pause' : 'site.play')}
                                </Button>
                                <Button
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
            {member && (
                <>
                    <TextInput
                        aria-label={t('together.search')}
                        onChange={(event) => setSearch(event.currentTarget.value)}
                        placeholder={t('together.search')}
                        value={search}
                    />
                    {term && results.isFetching && (
                        <Text c="dimmed" size="sm">
                            {t('together.searching')}
                        </Text>
                    )}
                    {term && results.isError && (
                        <Text c="red" role="status" size="sm">
                            {results.error.message}
                        </Text>
                    )}
                    {term && results.data?.songs.length === 0 && (
                        <Text c="dimmed" size="sm">
                            {t('together.noResults')}
                        </Text>
                    )}
                    {term &&
                        results.data?.songs.map((song) => (
                            <Group gap="xs" key={song.id} wrap="nowrap">
                                <Text className={styles.entryText} size="sm" truncate>
                                    {song.name} · {song.artistName}
                                </Text>
                                <Button
                                    onClick={() =>
                                        void roomCommand('add', { songIds: [song.id] }).catch(
                                            report,
                                        )
                                    }
                                    size="compact-xs"
                                    variant="light"
                                >
                                    {t('together.add')}
                                </Button>
                                <Button
                                    onClick={() =>
                                        void roomCommand('addNext', { songIds: [song.id] }).catch(
                                            report,
                                        )
                                    }
                                    size="compact-xs"
                                    variant="subtle"
                                >
                                    {t('together.addNext')}
                                </Button>
                            </Group>
                        ))}
                    {!current && selected && (
                        <Button
                            onClick={() =>
                                void roomCommand('add', { songIds: [selected.id] }).catch(report)
                            }
                            variant="light"
                        >
                            {t('site.addCurrent')}
                        </Button>
                    )}
                    <Text fw={700}>
                        {t('together.queue')} ({room?.queue.length ?? 0})
                    </Text>
                    <RoomQueue />
                </>
            )}
            {!compact && state && (
                <Stack gap={4}>
                    <Text fw={700}>
                        {t('together.members')} ({Object.keys(state.members).length})
                    </Text>
                    {Object.values(state.members).map((peer) => (
                        <Text key={peer.id} size="sm">
                            {peer.name} · {t('together.devices', { count: peer.devices })}
                        </Text>
                    ))}
                </Stack>
            )}
        </Stack>
    );
}
