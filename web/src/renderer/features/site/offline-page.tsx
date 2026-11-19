import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CommunityHeading, SiteHeading } from './community';
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
import { useAuthStore } from '/@/renderer/store/auth.store';
import { Badge } from '/@/shared/components/badge/badge';
import { usePlayerStoreBase } from '/@/renderer/store/player.store';
import { Button } from '/@/shared/components/button/button';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { Progress } from '/@/shared/components/progress/progress';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';
import { toast } from '/@/shared/components/toast/toast';

const emptyEntries: import('./offline').OfflineEntry[] = [];

export default function OfflinePage() {
    const server = useAuthStore((state) => state.currentServer);
    const owner = server?.userId ? encodeURIComponent(`${server.url}|${server.userId}`) : '';
    return <OfflineMusic key={owner} owner={owner} />;
}

function OfflineMusic({ owner }: { owner: string }) {
    const { t } = useTranslation();
    const supported = useOffline((state) => state.supported);
    const entries = useOffline((state) =>
        owner && state.scope === owner ? state.entries : emptyEntries,
    );
    const completed = useMemo(
        () => entries.filter((entry) => entry.status === 'complete'),
        [entries],
    );
    const [space, setSpace] = useState<StorageEstimate>();
    const [updates, setUpdates] = useState<
        Record<string, import('/@/shared/types/domain-types').Song>
    >({});
    useEffect(() => {
        if (owner)
            void loadOffline().catch((error: Error) => toast.error({ message: error.message }));
    }, [owner]);
    useEffect(() => {
        void navigator.storage
            ?.estimate()
            .then(setSpace)
            .catch(() => undefined);
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
                <SiteHeading icon="download" title={t('site.offlineMusic')} />
                <section className={styles.surface}>
                    <div className={styles.downloadOverview}>
                        <Stack gap="xs">
                            <Text c="dimmed" size="sm">
                                {supported ? t('site.offlineHelp') : t('site.offlineUnsupported')}
                            </Text>
                            {space?.quota ? (
                                <Stack gap={4}>
                                    <Text c="dimmed" size="sm">
                                        {t('site.storageUsed', {
                                            total: ((space.quota || 0) / 1048576).toFixed(0),
                                            used: ((space.usage || 0) / 1048576).toFixed(0),
                                        })}
                                    </Text>
                                    <Progress
                                        aria-label={t('site.community.browserStorage')}
                                        value={Math.min(
                                            100,
                                            ((space.usage ?? 0) / space.quota) * 100,
                                        )}
                                    />
                                </Stack>
                            ) : null}
                        </Stack>
                        <Group justify="flex-end">
                            <Button
                                disabled={!completed.length}
                                leftSection={<Icon icon="mediaPlay" size="sm" />}
                                onClick={() =>
                                    usePlayerStoreBase
                                        .getState()
                                        .setQueue(completed.map((entry) => entry.song))
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
                    </div>
                </section>
                <section className={styles.surface}>
                    <Stack gap="sm">
                        <Group gap="xs">
                            <CommunityHeading icon="download" title={t('site.community.downloads')} />
                            <Badge size="sm" variant="light">
                                {entries.length}
                            </Badge>
                        </Group>
                        {!entries.length && (
                            <Text c="dimmed" className={styles.emptyState} size="sm">
                                {t(supported ? 'site.noDownloads' : 'site.offlineUnsupported')}
                            </Text>
                        )}
                        {entries.length > 0 && (
                            <ul className={styles.downloadList}>
                                {entries.map((entry) => (
                                    <li className={styles.downloadEntry} key={entry.song.id}>
                                        <div aria-hidden="true" className={styles.downloadCover}>
                                            {entry.cover ? (
                                                <img alt="" loading="lazy" src={entry.cover} />
                                            ) : (
                                                <Icon icon="emptyImage" size="lg" />
                                            )}
                                        </div>
                                        <Stack gap="sm">
                                            <Group justify="space-between">
                                                <Text className={styles.wrapText} fw={600}>
                                                    {entry.song.name}
                                                </Text>
                                                <Badge size="sm" variant="light">
                                                    {t(`site.downloadStatus.${entry.status}`)}
                                                </Badge>
                                            </Group>
                                            <Text c="dimmed" className={styles.wrapText} size="sm">
                                                {[
                                                    entry.song.artists
                                                        ?.map((artist) => artist.name)
                                                        .join(' / '),
                                                    `${(entry.size / 1048576).toFixed(1)} MiB`,
                                                ]
                                                    .filter(Boolean)
                                                    .join(' · ')}
                                            </Text>
                                            {updates[entry.song.id] && (
                                                <Button
                                                    onClick={() =>
                                                        void downloadOffline(updates[entry.song.id])
                                                            .then(() =>
                                                                setUpdates((previous) => {
                                                                    const next = { ...previous };
                                                                    delete next[entry.song.id];
                                                                    return next;
                                                                }),
                                                            )
                                                            .catch((error: Error) =>
                                                                toast.error({
                                                                    message: error.message,
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
                                                    aria-label={t(
                                                        'site.downloadStatus.downloading',
                                                    )}
                                                    value={
                                                        entry.total
                                                            ? (entry.size / entry.total) * 100
                                                            : 0
                                                    }
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
                                                            usePlayerStoreBase
                                                                .getState()
                                                                .setQueue([entry.song])
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
                                                            void downloadOffline(entry.song).catch(
                                                                (e) =>
                                                                    toast.error({
                                                                        message: e.message,
                                                                    }),
                                                            )
                                                        }
                                                        size="compact-sm"
                                                        variant="light"
                                                    >
                                                        {t('site.retry')}
                                                    </Button>
                                                )}
                                                <Button
                                                    onClick={() =>
                                                        void deleteOffline(entry.song.id)
                                                    }
                                                    size="compact-sm"
                                                    variant="subtle"
                                                >
                                                    {t('site.delete')}
                                                </Button>
                                            </Group>
                                        </Stack>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </Stack>
                </section>
            </Stack>
        </div>
    );
}
