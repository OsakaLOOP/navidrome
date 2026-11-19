import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import {
    CommunityDirectory,
    CommunityHeading,
    CommunityHistory,
    CommunityLoad,
    CommunityPerson,
    CommunityTimeline,
    FriendActions,
    musicPath,
    SiteHeading,
    useCommunityScope,
} from './community';
import { MemberAvatar } from './room-members';
import { acceptSiteAuth, siteApi, SiteAuth } from './site-api';
import styles from './site.module.css';

import { useAuthStore } from '/@/renderer/store/auth.store';
import { Button } from '/@/shared/components/button/button';
import { FileButton } from '/@/shared/components/file-button/file-button';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { PasswordInput } from '/@/shared/components/password-input/password-input';
import { Select } from '/@/shared/components/select/select';
import { Stack } from '/@/shared/components/stack/stack';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { Text } from '/@/shared/components/text/text';
import { Textarea } from '/@/shared/components/textarea/textarea';
import { toast } from '/@/shared/components/toast/toast';

type Identity = {
    avatarVersion: number;
    bio: string;
    email: string;
    isAdmin: boolean;
    name: string;
    nickname: string;
    subject: string;
    userId: string;
};
type Privacy = { favorites: string; history: string; onlineCount: boolean; ratings: string };

export default function AccountPage() {
    const scope = useCommunityScope();
    return <Account key={scope} />;
}

function Account() {
    const { t } = useTranslation();
    const scope = useCommunityScope();
    const client = useQueryClient();
    const identity = useQuery({
        queryFn: () => siteApi.request<Identity>('/site/identity'),
        queryKey: ['site', 'identity', scope],
    });
    const [showSettings, setShowSettings] = useState(false);
    const privacy = useQuery({
        enabled: showSettings,
        queryFn: () => siteApi.request<Privacy>('/site/privacy'),
        queryKey: ['site', 'privacy', scope],
    });
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const privacyUpdate = useMutation({
        mutationFn: (settings: Partial<Privacy>) =>
            siteApi.request<Privacy>('/site/privacy', settings, 'PUT'),
        onError: (error) => toast.error({ message: error.message }),
        onSuccess: async (updated) => {
            client.setQueryData(['site', 'privacy', scope], updated);
            await client.invalidateQueries({ queryKey: ['site'] });
        },
    });
    return (
        <div className={styles.page}>
            <Stack gap="lg">
                <SiteHeading icon="users" title={t('site.account')}>
                    <Group gap="xs">
                        {identity.data && (
                            <Button
                                component={Link}
                                leftSection={<Icon icon="user" size="xs" />}
                                to={`/community/profile/${encodeURIComponent(identity.data.userId)}`}
                                variant="light"
                            >
                                {t('site.community.myProfile')}
                            </Button>
                        )}
                        <Button
                            aria-controls="community-settings"
                            aria-expanded={showSettings}
                            leftSection={<Icon icon="settings" size="xs" />}
                            onClick={() => setShowSettings((open) => !open)}
                            rightSection={
                                <Icon icon={showSettings ? 'arrowUpS' : 'dropdown'} size="xs" />
                            }
                            variant={showSettings ? 'light' : 'subtle'}
                        >
                            {t('site.community.settings')}
                        </Button>
                        <Button
                            leftSection={<Icon icon="signOut" size="xs" />}
                            onClick={() => useAuthStore.getState().actions.logout()}
                            variant="subtle"
                        >
                            {t('site.logout')}
                        </Button>
                    </Group>
                </SiteHeading>
                <section className={styles.surface} hidden={!showSettings} id="community-settings">
                    <Stack gap="md">
                        <CommunityHeading icon="settings" title={t('site.community.settings')} />
                        <CommunityLoad
                            error={identity.isError}
                            pending={identity.isPending}
                            retry={() => void identity.refetch()}
                        />
                        {identity.data && <ProfileSettings identity={identity.data} />}
                        <CommunityLoad
                            error={privacy.isError}
                            pending={privacy.isPending}
                            retry={() => void privacy.refetch()}
                        />
                        {privacy.data && (
                            <Stack className={styles.settingsGroup} gap="sm">
                                <div className={styles.settingsFields}>
                                    {(['favorites', 'history', 'ratings'] as const).map((field) => (
                                        <Select
                                            data={(field === 'favorites'
                                                ? ['private', 'count', 'public']
                                                : ['private', 'friends', 'public']
                                            ).map((value) => ({
                                                label: t(
                                                    field === 'favorites'
                                                        ? `site.visibility.${value}`
                                                        : `site.community.visibility.${value}`,
                                                ),
                                                value,
                                            }))}
                                            disabled={privacyUpdate.isPending}
                                            key={field}
                                            label={t(
                                                field === 'favorites'
                                                    ? 'site.favoriteVisibility'
                                                    : `site.community.${field}Visibility`,
                                            )}
                                            onChange={(value) => {
                                                if (value) privacyUpdate.mutate({ [field]: value });
                                            }}
                                            value={privacy.data[field]}
                                        />
                                    ))}
                                    <Select
                                        data={['private', 'public'].map((value) => ({
                                            label: t(`site.community.visibility.${value}`),
                                            value,
                                        }))}
                                        disabled={privacyUpdate.isPending}
                                        label={t('site.community.presenceVisibility')}
                                        onChange={(value) => {
                                            if (value) {
                                                privacyUpdate.mutate({ onlineCount: value === 'public' });
                                            }
                                        }}
                                        value={privacy.data.onlineCount ? 'public' : 'private'}
                                    />
                                </div>
                                <Text c="dimmed" size="xs">
                                    {t('site.community.publicProfileHelp')}
                                </Text>
                            </Stack>
                        )}
                        {!!identity.data?.subject && (
                            <details className={styles.settingsGroup}>
                                <summary>{t('site.bindExisting')}</summary>
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
                                        <Group>
                                            <Button loading={busy} type="submit">
                                                {t('site.bind')}
                                            </Button>
                                        </Group>
                                    </Stack>
                                </form>
                            </details>
                        )}
                        {message && (
                            <Text role="status" size="sm">
                                {message}
                            </Text>
                        )}
                    </Stack>
                </section>
                <div className={styles.squareColumns}>
                    <CommunityTimeline />
                    <Stack gap="md">
                        <CommunityDirectory />
                        {identity.data?.isAdmin && (
                            <details className={styles.surface}>
                                <summary>
                                    <span className={styles.sectionTitle}>
                                        <Icon icon="userManage" size="sm" />
                                        {t('site.community.moderation')}
                                    </span>
                                </summary>
                                <CommentReports />
                                <IdentityManager />
                            </details>
                        )}
                    </Stack>
                </div>
            </Stack>
        </div>
    );
}

function ProfileSettings({ identity }: { identity: Identity }) {
    const { t } = useTranslation();
    const client = useQueryClient();
    const [draft, setDraft] = useState<{ bio: string; nickname: string }>();
    const current = draft ?? identity;
    const save = useMutation({
        mutationFn: ({ bio, nickname }: { bio: string; nickname: string }) =>
            siteApi.request('/site/profile', { bio, nickname }, 'PUT'),
        onError: (error) => toast.error({ message: error.message }),
        onSuccess: async () => {
            await client.invalidateQueries({ queryKey: ['site'] });
            setDraft(undefined);
            toast.success({ message: t('site.saved') });
        },
    });
    const avatar = useMutation({
        mutationFn: (file: File | null) =>
            siteApi.request('/site/profile/avatar', file ?? undefined, file ? 'PUT' : 'DELETE'),
        onError: (error) => toast.error({ message: error.message }),
        onSuccess: () => client.invalidateQueries({ queryKey: ['site'] }),
    });
    return (
        <div className={styles.profileSettings}>
            <Stack gap="xs">
                <Group gap="sm" wrap="nowrap">
                    <MemberAvatar
                        className={styles.largeAvatar}
                        id={identity.userId}
                        name={identity.nickname || identity.name}
                        version={identity.avatarVersion}
                    />
                    <Stack className={styles.minWidth} gap={2}>
                        <Text fw={600} truncate>
                            {identity.nickname || identity.name}
                        </Text>
                        {identity.email && (
                            <Text c="dimmed" size="xs" truncate>
                                {identity.email}
                            </Text>
                        )}
                    </Stack>
                </Group>
                <Group gap="xs" mt="sm">
                    <FileButton
                        accept="image/jpeg,image/png,image/gif,image/webp"
                        onChange={(file) => {
                            if (!file) return;
                            if (file.size > 3 * 1024 * 1024)
                                toast.error({ message: t('site.community.avatarLimit') });
                            else avatar.mutate(file);
                        }}
                    >
                        {(props) => (
                            <Button
                                {...props}
                                leftSection={<Icon icon="uploadImage" size="xs" />}
                                loading={avatar.isPending}
                                size="compact-sm"
                                variant="light"
                            >
                                {t('site.community.setAvatar')}
                            </Button>
                        )}
                    </FileButton>
                    {!!identity.avatarVersion && (
                        <Button
                            disabled={avatar.isPending}
                            onClick={() => avatar.mutate(null)}
                            size="compact-sm"
                            variant="subtle"
                        >
                            {t('site.community.removeAvatar')}
                        </Button>
                    )}
                </Group>
                <Text c="dimmed" size="xs">
                    {t('site.community.avatarLimit')}
                </Text>
            </Stack>
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    if (draft) save.mutate(draft);
                }}
            >
                <Stack gap="sm">
                    <TextInput
                        label={t('site.community.nickname')}
                        maxLength={40}
                        onChange={(event) =>
                            setDraft({ bio: current.bio, nickname: event.currentTarget.value })
                        }
                        placeholder={identity.name}
                        value={current.nickname}
                    />
                    <Textarea
                        autosize
                        label={t('site.community.bio')}
                        maxLength={500}
                        maxRows={6}
                        minRows={2}
                        onChange={(event) =>
                            setDraft({ bio: event.currentTarget.value, nickname: current.nickname })
                        }
                        value={current.bio}
                    />
                    <Group justify="flex-end" mt="xs">
                        <Button
                            disabled={!draft}
                            leftSection={<Icon icon="save" size="xs" />}
                            loading={save.isPending}
                            type="submit"
                        >
                            {t('site.save')}
                        </Button>
                    </Group>
                </Stack>
            </form>
        </div>
    );
}

export function ProfilePage() {
    const { userId } = useParams();
    const scope = useCommunityScope();
    return userId ? <Profile key={`${scope}:${userId}`} userId={userId} /> : null;
}

function Profile({ userId }: { userId: string }) {
    const scope = useCommunityScope();
    const [kind, setKind] = useState('song');
    type Profile = {
        canView: boolean;
        favorites: { id: string; kind: string; title: string }[];
        next?: null | number;
        person: CommunityPerson;
    };
    const profile = useInfiniteQuery({
        getNextPageParam: (last: Profile) => last.next ?? undefined,
        initialPageParam: 0,
        queryFn: ({ pageParam }): Promise<Profile> =>
            siteApi.request(
                `/site/profile/${encodeURIComponent(userId)}?kind=${kind}&offset=${pageParam}`,
            ),
        queryKey: ['site', 'profile', scope, userId, kind],
    });
    const data = profile.data?.pages[0];
    const favorites = data?.canView
        ? (profile.data?.pages.flatMap((page) => page.favorites) ?? [])
        : [];
    const { t } = useTranslation();
    return (
        <div className={styles.page}>
            <Stack gap="lg">
                <Group>
                    <Button component={Link} to="/account" variant="light">
                        {t('site.account')}
                    </Button>
                </Group>
                <CommunityLoad
                    error={profile.isError}
                    pending={profile.isPending}
                    retry={() => void profile.refetch()}
                />
                {data && (
                    <>
                        <section className={styles.surface}>
                            <Stack gap="sm">
                                <Group justify="space-between">
                                    <Group gap="md" wrap="nowrap">
                                        <MemberAvatar
                                            className={styles.largeAvatar}
                                            id={userId}
                                            name={data.person.name}
                                            version={data.person.avatarVersion}
                                        />
                                        <Stack className={styles.minWidth} gap={4}>
                                            <Text
                                                className={styles.wrapText}
                                                component="h1"
                                                fw={700}
                                                size="xl"
                                            >
                                                {data.person.name}
                                            </Text>
                                            <Text c="dimmed" size="sm">
                                                {t(`site.community.status.${data.person.status}`)}
                                                {data.person.track ? ` · ${data.person.track}` : ''}
                                            </Text>
                                        </Stack>
                                    </Group>
                                    <FriendActions person={data.person} />
                                </Group>
                                {data.person.bio && (
                                    <Text className={styles.bio} size="sm">
                                        {data.person.bio}
                                    </Text>
                                )}
                            </Stack>
                        </section>
                        <div className={styles.communityColumns}>
                            <Stack gap="md">
                                <CommunityHistory userId={userId} />
                                <section className={styles.surface}>
                                    <Stack gap="md">
                                        <CommunityHeading
                                            icon="favorite"
                                            title={t('site.community.favorites')}
                                        />
                                        {data && !data.canView && (
                                            <Text c="dimmed">
                                                {t('discussion.privateFavorites')}
                                            </Text>
                                        )}
                                        {data?.canView && (
                                            <Group gap="xs">
                                                {(['song', 'album', 'artist'] as const).map(
                                                    (item) => (
                                                        <Button
                                                            aria-pressed={kind === item}
                                                            key={item}
                                                            onClick={() => setKind(item)}
                                                            variant={
                                                                kind === item ? 'light' : 'subtle'
                                                            }
                                                        >
                                                            {t(`entity.${item}`, { count: 2 })}
                                                        </Button>
                                                    ),
                                                )}
                                            </Group>
                                        )}
                                        {data?.canView && !favorites.length && (
                                            <Text c="dimmed" className={styles.emptyState}>
                                                {t('discussion.emptyFavorites')}
                                            </Text>
                                        )}
                                        {favorites.map((favorite) => (
                                            <Link
                                                className={styles.mediaLink}
                                                key={`${favorite.kind}:${favorite.id}`}
                                                to={musicPath(favorite.kind, favorite.id)}
                                            >
                                                {favorite.title}
                                            </Link>
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
                                </section>
                            </Stack>
                            <CommunityTimeline userId={userId} />
                        </div>
                    </>
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
        <Stack gap="sm" mt="md">
            <CommunityHeading icon="error" order={3} title={t('discussion.reports')} />
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
                <CommunityHeading icon="userManage" order={3} title={t('site.manageBindings')} />
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
