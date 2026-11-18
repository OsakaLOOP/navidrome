import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import { acceptSiteAuth, siteApi, SiteAuth } from './site-api';
import styles from './site.module.css';

import { useAuthStore } from '/@/renderer/store/auth.store';
import { Button } from '/@/shared/components/button/button';
import { Group } from '/@/shared/components/group/group';
import { PasswordInput } from '/@/shared/components/password-input/password-input';
import { Select } from '/@/shared/components/select/select';
import { Stack } from '/@/shared/components/stack/stack';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { Text } from '/@/shared/components/text/text';

export default function AccountPage() {
    const { t } = useTranslation();
    const client = useQueryClient();
    const identity = useQuery({
        queryFn: () =>
            siteApi.request<{ email: string; isAdmin: boolean; name: string; subject: string }>(
                '/site/identity',
            ),
        queryKey: ['site', 'identity'],
    });
    const privacy = useQuery({
        queryFn: () => siteApi.request<{ favorites: string }>('/site/privacy'),
        queryKey: ['site', 'privacy'],
    });
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    return (
        <div className={styles.page}>
            <Stack gap="lg">
                <Text fw={700} size="xl">
                    {t('site.account')}
                </Text>
                <section className={styles.panel}>
                    <Stack>
                        <Text fw={600}>{identity.data?.name || t('site.adminLogin')}</Text>
                        <Text c="dimmed" size="sm">
                            {identity.data?.email}
                        </Text>
                        <Select
                            data={['private', 'count', 'public'].map((v) => ({
                                label: t(`site.visibility.${v}`),
                                value: v,
                            }))}
                            label={t('site.favoriteVisibility')}
                            onChange={async (value) => {
                                try {
                                    await siteApi.request(
                                        '/site/privacy',
                                        { favorites: value },
                                        'PUT',
                                    );
                                    await client.invalidateQueries({ queryKey: ['site'] });
                                } catch (e) {
                                    setMessage((e as Error).message);
                                }
                            }}
                            value={privacy.data?.favorites || 'private'}
                        />
                        <Button
                            onClick={() => useAuthStore.getState().actions.logout()}
                            variant="subtle"
                        >
                            {t('site.logout')}
                        </Button>
                    </Stack>
                </section>
                {!!identity.data?.subject && (
                    <section className={styles.panel}>
                        <form
                            onSubmit={async (event) => {
                                event.preventDefault();
                                setBusy(true);
                                setMessage('');
                                try {
                                    const data = await siteApi.request<SiteAuth>(
                                        '/site/identity/bind',
                                        { password, username },
                                    );
                                    acceptSiteAuth(data);
                                    setPassword('');
                                    setMessage(t('site.bound'));
                                    await client.invalidateQueries();
                                } catch (e) {
                                    setMessage((e as Error).message);
                                } finally {
                                    setBusy(false);
                                }
                            }}
                        >
                            <Stack>
                                <Text fw={600}>{t('site.bindExisting')}</Text>
                                <Text c="dimmed" size="sm">
                                    {t('site.bindHelp')}
                                </Text>
                                <TextInput
                                    autoComplete="username"
                                    label={t('site.username')}
                                    onChange={(e) => setUsername(e.currentTarget.value)}
                                    required
                                    value={username}
                                />
                                <PasswordInput
                                    autoComplete="current-password"
                                    label={t('site.password')}
                                    onChange={(e) => setPassword(e.currentTarget.value)}
                                    required
                                    value={password}
                                />
                                <Button loading={busy} type="submit">
                                    {t('site.bind')}
                                </Button>
                            </Stack>
                        </form>
                    </section>
                )}
                {message && (
                    <Text role="status" size="sm">
                        {message}
                    </Text>
                )}
                {identity.data?.isAdmin && (
                    <>
                        <CommentReports />
                        <IdentityManager />
                    </>
                )}
            </Stack>
        </div>
    );
}

export function ProfilePage() {
    const { userId } = useParams();
    const server = useAuthStore((state) => state.currentServer);
    const [kind, setKind] = useState('song');
    type Profile = {
        canView: boolean;
        favorites: { id: string; kind: string; title: string }[];
        name: string;
        next?: null | number;
    };
    const profile = useInfiniteQuery({
        enabled: Boolean(userId && server),
        getNextPageParam: (last: Profile) => last.next ?? undefined,
        initialPageParam: 0,
        queryFn: ({ pageParam }): Promise<Profile> =>
            siteApi.request(
                `/site/profile/${encodeURIComponent(userId!)}?kind=${kind}&offset=${pageParam}`,
            ),
        queryKey: ['site', 'profile', server?.id, server?.userId, userId, kind],
    });
    const data = profile.data?.pages[0];
    const favorites = profile.data?.pages.flatMap((page) => page.favorites) ?? [];
    const { t } = useTranslation();
    return (
        <div className={styles.page}>
            <Stack>
                <Text fw={700} size="xl">
                    {data?.name}
                </Text>
                <Text c="dimmed">{t('site.publicFavorites')}</Text>
                {profile.isPending && <Text role="status">{t('discussion.loading')}</Text>}
                {profile.isError && (
                    <Button onClick={() => void profile.refetch()} variant="light">
                        {t('discussion.retry')}
                    </Button>
                )}
                {data && !data.canView && (
                    <Text c="dimmed">{t('discussion.privateFavorites')}</Text>
                )}
                {data?.canView && (
                    <Group gap="xs">
                        {(['song', 'album', 'artist'] as const).map((item) => (
                            <Button
                                aria-pressed={kind === item}
                                key={item}
                                onClick={() => setKind(item)}
                                variant={kind === item ? 'light' : 'subtle'}
                            >
                                {t(`entity.${item}`, { count: 2 })}
                            </Button>
                        ))}
                    </Group>
                )}
                {data?.canView && !favorites.length && (
                    <Text c="dimmed">{t('discussion.emptyFavorites')}</Text>
                )}
                {favorites.map((favorite) => (
                    <Button
                        component={Link}
                        key={`${favorite.kind}:${favorite.id}`}
                        to={
                            favorite.kind === 'album'
                                ? `/library/albums/${favorite.id}`
                                : favorite.kind === 'artist'
                                  ? `/library/artists/${favorite.id}`
                                  : `/track/${favorite.id}`
                        }
                        variant="subtle"
                    >
                        {favorite.title}
                    </Button>
                ))}
                {profile.hasNextPage && (
                    <Button
                        loading={profile.isFetchingNextPage}
                        onClick={() => void profile.fetchNextPage()}
                        variant="light"
                    >
                        {t('site.more')}
                    </Button>
                )}
            </Stack>
        </div>
    );
}

function CommentReports() {
    const { t } = useTranslation();
    const server = useAuthStore((state) => state.currentServer);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState<number>();
    const reports = useQuery({
        queryFn: () =>
            siteApi.request<
                { body: string; count: number; id: number; name: string; reason: string }[]
            >('/site/comment-reports'),
        queryKey: ['site', 'comment-reports', server?.id, server?.userId],
    });
    const review = async (id: number, remove: boolean) => {
        setBusy(id);
        setError('');
        try {
            await siteApi.request(`/site/comment-reports/${id}`, { remove }, 'PUT');
            await reports.refetch();
        } catch (cause) {
            setError((cause as Error).message);
        } finally {
            setBusy(undefined);
        }
    };
    return (
        <Stack gap="xs">
            <Text fw={700}>{t('discussion.reports')}</Text>
            {error && (
                <Text c="red" role="alert">
                    {error}
                </Text>
            )}
            {reports.isError && (
                <Button onClick={() => void reports.refetch()} variant="light">
                    {t('discussion.retry')}
                </Button>
            )}
            {reports.data?.length === 0 && <Text c="dimmed">{t('discussion.noReports')}</Text>}
            {reports.data?.map((item) => (
                <Stack gap={4} key={item.id}>
                    <Text fw={600}>
                        {item.name} · {item.count}
                    </Text>
                    <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
                        {item.body}
                    </Text>
                    <Text
                        c="dimmed"
                        size="sm"
                        style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}
                    >
                        {item.reason}
                    </Text>
                    <Group gap="xs">
                        <Button
                            disabled={busy !== undefined}
                            onClick={() => void review(item.id, false)}
                            size="compact-sm"
                            variant="light"
                        >
                            {t('discussion.keepComment')}
                        </Button>
                        <Button
                            color="red"
                            disabled={busy !== undefined}
                            onClick={() => void review(item.id, true)}
                            size="compact-sm"
                            variant="light"
                        >
                            {t('site.delete')}
                        </Button>
                    </Group>
                </Stack>
            ))}
        </Stack>
    );
}

function IdentityManager() {
    const { t } = useTranslation();
    const client = useQueryClient();
    const { data } = useQuery({
        queryFn: () =>
            siteApi.request<{
                identities: { email: string; name: string; subject: string; userId: string }[];
                users: { id: string; username: string }[];
            }>('/site/identities'),
        queryKey: ['site', 'identities'],
    });
    const [message, setMessage] = useState('');
    return (
        <section className={styles.panel}>
            <Stack>
                <Text fw={600}>{t('site.manageBindings')}</Text>
                {data?.identities.map((identity) => (
                    <Select
                        data={data.users.map((u) => ({ label: u.username, value: u.id }))}
                        key={identity.subject}
                        label={`${identity.name} · ${identity.email}`}
                        onChange={async (userId) => {
                            try {
                                await siteApi.request(
                                    '/site/identities',
                                    { subject: identity.subject, userId },
                                    'PUT',
                                );
                                await client.invalidateQueries({
                                    queryKey: ['site', 'identities'],
                                });
                                setMessage(t('site.bound'));
                            } catch (e) {
                                setMessage((e as Error).message);
                            }
                        }}
                        value={identity.userId}
                    />
                ))}
                {message && (
                    <Text role="status" size="sm">
                        {message}
                    </Text>
                )}
            </Stack>
        </section>
    );
}
