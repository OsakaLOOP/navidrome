import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import { acceptSiteAuth, siteApi, SiteAuth } from './site-api';
import styles from './site.module.css';

import { useAuthStore } from '/@/renderer/store/auth.store';
import { Button } from '/@/shared/components/button/button';
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
                {identity.data?.isAdmin && <IdentityManager />}
            </Stack>
        </div>
    );
}

export function ProfilePage() {
    const { userId } = useParams();
    const { data, error } = useQuery({
        queryFn: () =>
            siteApi.request<{
                favorites: { id: string; item: { name?: string; title?: string }; kind: string }[];
                name: string;
                visibility: string;
            }>(`/site/profile/${userId}`),
        queryKey: ['site', 'profile', userId],
    });
    const { t } = useTranslation();
    return (
        <div className={styles.page}>
            <Stack>
                <Text fw={700} size="xl">
                    {data?.name}
                </Text>
                <Text c="dimmed">{t('site.publicFavorites')}</Text>
                {error && <Text c="red">{error.message}</Text>}
                {data?.favorites.map((favorite) => (
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
                        {favorite.item.name || favorite.item.title}
                    </Button>
                ))}
            </Stack>
        </div>
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
