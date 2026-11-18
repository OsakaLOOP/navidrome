import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { shallow } from 'zustand/shallow';

import {
    cancelOffline,
    clearOffline,
    deleteOffline,
    downloadOffline,
    loadOffline,
    useOffline,
} from './offline';
import styles from './site.module.css';

import { api } from '/@/renderer/api';
import { usePlayerStoreBase } from '/@/renderer/store/player.store';
import { Button } from '/@/shared/components/button/button';
import { Group } from '/@/shared/components/group/group';
import { Progress } from '/@/shared/components/progress/progress';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';
import { toast } from '/@/shared/components/toast/toast';

export default function OfflinePage() {
    const { t } = useTranslation();
    const { entries, supported } = useOffline();
    const completed = useOffline(
        (state) => state.entries.filter((entry) => entry.status === 'complete'),
        shallow,
    );
    const [space, setSpace] = useState<StorageEstimate>();
    const [updates, setUpdates] = useState<
        Record<string, import('/@/shared/types/domain-types').Song>
    >({});
    useEffect(() => {
        void loadOffline();
        void navigator.storage?.estimate().then(setSpace);
    }, [entries.length]);
    useEffect(() => {
        if (!navigator.onLine) return;
        let active = true;
        void (async () => {
            for (const entry of completed) {
                try {
                    const song = await api.controller.getSongDetail({
                        apiClientProps: { serverId: entry.song._serverId },
                        query: { id: entry.song.id },
                    });
                    if (active && song.updatedAt !== entry.song.updatedAt)
                        setUpdates((previous) => ({ ...previous, [song.id]: song }));
                } catch {
                    /* 已下载曲目继续保留。 */
                }
            }
        })();
        return () => {
            active = false;
        };
    }, [completed]);
    return (
        <div className={styles.page}>
            <Stack gap="lg">
                <Text fw={700} size="xl">
                    {t('site.offlineMusic')}
                </Text>
                <Text c="dimmed" size="sm">
                    {supported ? t('site.offlineHelp') : t('site.offlineUnsupported')}
                </Text>
                {space && (
                    <Text c="dimmed" size="sm">
                        {t('site.storageUsed', {
                            total: ((space.quota || 0) / 1048576).toFixed(0),
                            used: ((space.usage || 0) / 1048576).toFixed(0),
                        })}
                    </Text>
                )}
                <Group>
                    <Button
                        disabled={!entries.some((e) => e.status === 'complete')}
                        onClick={() =>
                            usePlayerStoreBase
                                .getState()
                                .setQueue(
                                    entries
                                        .filter((e) => e.status === 'complete')
                                        .map((e) => e.song),
                                )
                        }
                    >
                        {t('site.playAll')}
                    </Button>
                    <Button
                        disabled={!entries.length}
                        onClick={() => {
                            if (confirm(t('site.clearOfflineConfirm'))) void clearOffline();
                        }}
                        variant="subtle"
                    >
                        {t('site.clearDownloads')}
                    </Button>
                </Group>
                {!entries.length && <Text c="dimmed">{t('site.noDownloads')}</Text>}
                {entries.map((entry) => (
                    <section className={styles.panel} key={entry.song.id}>
                        <Stack gap="sm">
                            <Group justify="space-between">
                                <Text fw={600}>{entry.song.name}</Text>
                                <Text c="dimmed" size="sm">
                                    {t(`site.downloadStatus.${entry.status}`)}
                                </Text>
                            </Group>
                            <Text c="dimmed" size="sm">
                                {entry.song.artists?.map((a) => a.name).join(' / ')} ·{' '}
                                {(entry.size / 1048576).toFixed(1)} MB
                            </Text>
                            {entry.cover && (
                                <img
                                    alt=""
                                    height={64}
                                    src={entry.cover}
                                    style={{ borderRadius: 8, objectFit: 'cover' }}
                                    width={64}
                                />
                            )}
                            {updates[entry.song.id] && (
                                <Button
                                    onClick={() =>
                                        void downloadOffline(updates[entry.song.id]).then(() =>
                                            setUpdates((previous) => {
                                                const next = { ...previous };
                                                delete next[entry.song.id];
                                                return next;
                                            }),
                                        )
                                    }
                                    size="compact-sm"
                                    variant="light"
                                >
                                    {t('site.updateAvailable')}
                                </Button>
                            )}
                            {entry.status === 'downloading' && (
                                <Progress
                                    value={entry.total ? (entry.size / entry.total) * 100 : 0}
                                />
                            )}
                            {entry.error && entry.status === 'error' && (
                                <Text c="red" size="sm">
                                    {entry.error}
                                </Text>
                            )}
                            <Group>
                                {entry.status === 'complete' ? (
                                    <Button
                                        onClick={() =>
                                            usePlayerStoreBase.getState().setQueue([entry.song])
                                        }
                                        size="compact-sm"
                                        variant="light"
                                    >
                                        {t('site.play')}
                                    </Button>
                                ) : entry.status === 'downloading' ? (
                                    <Button
                                        onClick={() => cancelOffline(entry.song.id)}
                                        size="compact-sm"
                                        variant="subtle"
                                    >
                                        {t('site.cancel')}
                                    </Button>
                                ) : (
                                    <Button
                                        disabled={!navigator.onLine}
                                        onClick={() =>
                                            void downloadOffline(entry.song).catch((e) =>
                                                toast.error({ message: e.message }),
                                            )
                                        }
                                        size="compact-sm"
                                        variant="light"
                                    >
                                        {t('site.retry')}
                                    </Button>
                                )}
                                <Button
                                    onClick={() => void deleteOffline(entry.song.id)}
                                    size="compact-sm"
                                    variant="subtle"
                                >
                                    {t('site.delete')}
                                </Button>
                            </Group>
                        </Stack>
                    </section>
                ))}
            </Stack>
        </div>
    );
}
