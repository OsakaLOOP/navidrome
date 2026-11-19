import { closeModal, openModal } from '@mantine/modals';
import { useQuery } from '@tanstack/react-query';
import { t } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { playlistsQueries } from '/@/renderer/features/playlists/api/playlists-api';
import { useAuthStore } from '/@/renderer/store/auth.store';
import {
    getPersonalQueueSongs,
    isSharedPlayback,
    usePlayerStoreBase,
} from '/@/renderer/store/player.store';
import { Button } from '/@/shared/components/button/button';
import { Checkbox } from '/@/shared/components/checkbox/checkbox';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { Select } from '/@/shared/components/select/select';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';
import { toast } from '/@/shared/components/toast/toast';
import { PlaylistListSort, ServerListItem, Song, SortOrder } from '/@/shared/types/domain-types';
import { Play } from '/@/shared/types/types';

type SharedTarget = {
    add: (songIds: string[], skipDuplicates: boolean) => Promise<unknown>;
    songIds: () => string[];
};

const personalSource = 'personal';

function uniqueSongs(songs: Song[], queueIds: string[]) {
    const seen = new Set(queueIds);
    return songs.filter(({ id }) => {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
    });
}

export function openImportQueueModal(shared?: SharedTarget) {
    const server = useAuthStore.getState().currentServer;
    if (!server) return;
    const modalId = openModal({
        children: (
            <ImportQueueForm close={() => closeModal(modalId)} server={server} shared={shared} />
        ),
        title: (
            <Group gap="xs" wrap="nowrap">
                <Icon icon="mediaPlayLast" />
                {t('queueImport.title')}
            </Group>
        ),
    });
}

function ImportQueueForm({
    close,
    server,
    shared,
}: {
    close: () => void;
    server: ServerListItem;
    shared?: SharedTarget;
}) {
    const { t } = useTranslation();
    const [source, setSource] = useState<null | string>(null);
    const [skipDuplicates, setSkipDuplicates] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const playlistId = source?.startsWith('playlist:') ? source.slice('playlist:'.length) : '';
    const personalSongs = shared ? getPersonalQueueSongs() : [];
    const playlists = useQuery(
        playlistsQueries.list({
            query: { sortBy: PlaylistListSort.NAME, sortOrder: SortOrder.ASC, startIndex: 0 },
            serverId: server.id,
        }),
    );
    const tracks = useQuery(
        playlistsQueries.songList({
            options: { enabled: Boolean(playlistId) },
            query: { id: playlistId },
            serverId: server.id,
        }),
    );
    const songs = source === personalSource ? personalSongs : (tracks.data?.items ?? []);
    const queueIds = () =>
        shared?.songIds() ?? usePlayerStoreBase.getState().getQueueOrder().items.map(({ id }) => id);
    const unique = uniqueSongs(songs, queueIds());
    const hasDuplicates = unique.length < songs.length;
    const deduplicate = hasDuplicates && skipDuplicates;
    const count = deduplicate ? unique.length : songs.length;
    const loading = Boolean(playlistId) && tracks.isFetching;
    const unavailable = loading || Boolean(playlistId && tracks.isError) || count === 0;
    const formError = error || (playlistId && tracks.error?.message) || playlists.error?.message;

    const submit = async () => {
        if (saving || unavailable) return;
        setSaving(true);
        setError('');
        try {
            const current = useAuthStore.getState().currentServer;
            if (
                current?.id !== server.id ||
                current.userId !== server.userId ||
                isSharedPlayback() !== Boolean(shared)
            ) {
                throw new Error(t('queueImport.targetChanged'));
            }
            const items = deduplicate ? uniqueSongs(songs, queueIds()) : songs;
            if (items.length > 0) {
                if (shared) await shared.add(items.map(({ id }) => id), deduplicate);
                else usePlayerStoreBase.getState().addToQueueByType(items, Play.LAST);
                toast.success({ message: t('queueImport.success') });
            }
            close();
        } catch (error) {
            setError((error as Error).message);
        } finally {
            setSaving(false);
        }
    };

    return (
        <form
            onSubmit={(event) => {
                event.preventDefault();
                void submit();
            }}
        >
            <Stack gap="sm">
                <Select
                    data={[
                        ...(shared
                            ? [{
                                  disabled: personalSongs.length === 0,
                                  label: t('queueImport.personalQueue'),
                                  value: personalSource,
                              }]
                            : []),
                        ...(playlists.data?.items ?? []).map(({ id, name }) => ({
                            label: name,
                            value: `playlist:${id}`,
                        })),
                    ]}
                    disabled={saving}
                    label={t('queueImport.source')}
                    leftSection={<Icon icon="playlist" />}
                    nothingFoundMessage={t('common.noResultsFromQuery')}
                    onChange={(value) => {
                        setSource(value);
                        setSkipDuplicates(true);
                        setError('');
                    }}
                    searchable
                    value={source}
                />
                {hasDuplicates && (
                    <Checkbox
                        checked={skipDuplicates}
                        disabled={saving}
                        label={t('queueImport.skipDuplicates')}
                        onChange={(event) => setSkipDuplicates(event.currentTarget.checked)}
                    />
                )}
                {formError ? (
                    <Text c="red" role="status" size="sm">
                        {formError}
                    </Text>
                ) : source && !loading ? (
                    <Text c="dimmed" size="sm">
                        {t('entity.trackWithCount', { count })}
                    </Text>
                ) : null}
                <Group gap="xs" justify="flex-end">
                    <Button leftSection={<Icon icon="x" size="xs" />} onClick={close} variant="subtle">
                        {t('common.cancel')}
                    </Button>
                    <Button
                        disabled={unavailable}
                        leftSection={<Icon icon="mediaPlayLast" size="xs" />}
                        loading={saving}
                        type="submit"
                    >
                        {t('queueImport.append')}
                    </Button>
                </Group>
            </Stack>
        </form>
    );
}
