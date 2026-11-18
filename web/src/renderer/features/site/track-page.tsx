import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import { EntityPanel } from './entity-panel';
import { downloadOffline } from './offline';
import { roomCommand, useRoomActive } from './room';
import styles from './site.module.css';

import { api } from '/@/renderer/api';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { LibraryHeaderBar } from '/@/renderer/features/shared/components/library-header-bar';
import { useAuthStore } from '/@/renderer/store/auth.store';
import { formatDurationStringShort } from '/@/renderer/utils/format';
import { Button } from '/@/shared/components/button/button';
import { Group } from '/@/shared/components/group/group';
import { Image } from '/@/shared/components/image/image';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';
import { toast } from '/@/shared/components/toast/toast';
import { LibraryItem } from '/@/shared/types/domain-types';
import { Play } from '/@/shared/types/types';

export default function TrackPage() {
    const player = usePlayer();
    const shared = useRoomActive();
    const { id } = useParams();
    const { t } = useTranslation();
    const serverId = useAuthStore((s) => s.currentServer?.id);
    const { data, error, isPending } = useQuery({
        queryFn: () =>
            api.controller.getSongDetail({ apiClientProps: { serverId }, query: { id: id! } }),
        queryKey: [serverId, 'site-track', id],
    });
    const cover =
        data &&
        api.controller.getImageRequest({
            apiClientProps: { serverId },
            query: { id: data.imageId ?? data.id, itemType: LibraryItem.SONG, size: 256 },
        });
    return (
        <div className={styles.page}>
            <Stack gap="lg">
                <LibraryHeaderBar>
                    <LibraryHeaderBar.Title>
                        {data?.name ?? t('site.trackDetails')}
                    </LibraryHeaderBar.Title>
                </LibraryHeaderBar>
                {isPending && <Text role="status">{t('discussion.loading')}</Text>}
                {error && <Text c="red">{error.message}</Text>}
                {data && (
                    <Group align="center" wrap="nowrap">
                        {cover && (
                            <Image
                                alt=""
                                height={88}
                                imageRequest={cover}
                                src={cover.url}
                                width={88}
                            />
                        )}
                        <Stack gap={4}>
                            {data.albumId && data.album && (
                                <Link to={`/library/albums/${data.albumId}`}>{data.album}</Link>
                            )}
                            <Text c="dimmed" size="sm">
                                {[
                                    formatDurationStringShort(data.duration),
                                    data.container?.toUpperCase(),
                                ]
                                    .filter(Boolean)
                                    .join(' · ')}
                            </Text>
                        </Stack>
                    </Group>
                )}
                <Group>
                    {data?.artists.map((artist) => (
                        <Button
                            component={Link}
                            key={artist.id}
                            to={`/library/artists/${artist.id}`}
                            variant="subtle"
                        >
                            {artist.name}
                        </Button>
                    ))}
                </Group>
                {data && (
                    <Group>
                        <Button onClick={() => player.addToQueueByData([data], Play.NOW)}>
                            {t('site.play')}
                        </Button>
                        <Button
                            onClick={() =>
                                void downloadOffline(data).catch((e) =>
                                    toast.error({ message: e.message }),
                                )
                            }
                            variant="light"
                        >
                            {t('site.download')}
                        </Button>
                        {shared && (
                            <Button
                                onClick={() =>
                                    void roomCommand('add', { songIds: [data.id] }).catch((e) =>
                                        toast.error({ message: e.message }),
                                    )
                                }
                                variant="light"
                            >
                                {t('site.addToRoom')}
                            </Button>
                        )}
                    </Group>
                )}
                {id && <EntityPanel id={id} key={id} kind="song" />}
            </Stack>
        </div>
    );
}
