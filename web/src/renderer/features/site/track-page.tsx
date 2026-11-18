import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import { EntityPanel } from './entity-panel';
import { downloadOffline } from './offline';
import { roomCommand } from './room';
import styles from './site.module.css';

import { api } from '/@/renderer/api';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { useAuthStore } from '/@/renderer/store/auth.store';
import { Button } from '/@/shared/components/button/button';
import { Group } from '/@/shared/components/group/group';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';
import { toast } from '/@/shared/components/toast/toast';
import { Play } from '/@/shared/types/types';

export default function TrackPage() {
    const player = usePlayer();
    const { id } = useParams();
    const { t } = useTranslation();
    const serverId = useAuthStore((s) => s.currentServer?.id);
    const { data, error } = useQuery({
        queryFn: () =>
            api.controller.getSongDetail({ apiClientProps: { serverId }, query: { id: id! } }),
        queryKey: [serverId, 'site-track', id],
    });
    return (
        <div className={styles.page}>
            <Stack gap="lg">
                <Text fw={700} size="xl">
                    {data?.name}
                </Text>
                {error && <Text c="red">{error.message}</Text>}
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
                    </Group>
                )}
                {id && <EntityPanel id={id} key={id} kind="song" />}
            </Stack>
        </div>
    );
}
