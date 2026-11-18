import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router';

import { acceptSiteAuth, restoreSiteSession, siteApi, SiteAuth } from './site-api';
import styles from './site.module.css';

import { useAuthStore } from '/@/renderer/store/auth.store';
import { Button } from '/@/shared/components/button/button';
import { Center } from '/@/shared/components/center/center';
import { Paper } from '/@/shared/components/paper/paper';
import { PasswordInput } from '/@/shared/components/password-input/password-input';
import { Stack } from '/@/shared/components/stack/stack';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { Text } from '/@/shared/components/text/text';

export function SiteLogin() {
    const { t } = useTranslation();
    const current = useAuthStore((s) => s.currentServer);
    const settings = window as Window & { REGISTRATION_ENABLED?: boolean; SERVERMAN_URL?: string };
    const local = !settings.SERVERMAN_URL;
    const [register, setRegister] = useState(false);
    const [admin, setAdmin] = useState(false);
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [code, setCode] = useState('');
    const [twoFactor, setTwoFactor] = useState(false);
    const [recovery, setRecovery] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    useEffect(() => {
        restoreSiteSession()
            .then(acceptSiteAuth)
            .catch(() => {})
            .finally(() => setLoading(false));
    }, []);

    if (current) return <Navigate replace to="/" />;

    return (
        <Center h="100dvh" p="md">
            <Paper className={styles.login} p="xl" radius="lg" withBorder>
                <form
                    onSubmit={async (event) => {
                        event.preventDefault();
                        setLoading(true);
                        setError('');
                        try {
                            const data = await siteApi.request<SiteAuth>(
                                local && register
                                    ? '/auth/register'
                                    : local || admin
                                      ? '/auth/login'
                                      : '/auth/serverman',
                                local || admin
                                    ? { password, username }
                                    : { code, email: username, password, recovery },
                            );
                            if (data.twoFactorRequired) setTwoFactor(true);
                            else {
                                sessionStorage.removeItem('ndfork-signed-out');
                                acceptSiteAuth(data);
                            }
                        } catch (e) {
                            setError((e as Error).message);
                        } finally {
                            setLoading(false);
                        }
                    }}
                >
                    <Stack gap="lg">
                        <div className={styles.eyebrow}>ndFork</div>
                        <Text fw={700} size="xl">
                            {t('site.loginTitle')}
                        </Text>
                        <Text c="dimmed" size="sm">
                            {t(
                                local
                                    ? register
                                        ? 'site.register'
                                        : 'site.localLogin'
                                    : admin
                                      ? 'site.adminLogin'
                                      : 'site.centralLogin',
                            )}
                        </Text>
                        {twoFactor ? (
                            <>
                                <TextInput
                                    autoComplete="one-time-code"
                                    autoFocus
                                    label={t(
                                        recovery ? 'site.recoveryCode' : 'site.verificationCode',
                                    )}
                                    onChange={(e) => setCode(e.currentTarget.value)}
                                    required
                                    value={code}
                                />
                                <Button
                                    onClick={() => setRecovery(!recovery)}
                                    size="compact-sm"
                                    variant="subtle"
                                >
                                    {t(recovery ? 'site.useTotp' : 'site.useRecovery')}
                                </Button>
                            </>
                        ) : (
                            <>
                                <TextInput
                                    autoComplete="username"
                                    label={t(local || admin ? 'site.username' : 'site.email')}
                                    onChange={(e) => setUsername(e.currentTarget.value)}
                                    required
                                    type={local || admin ? 'text' : 'email'}
                                    value={username}
                                />
                                <PasswordInput
                                    autoComplete={register ? 'new-password' : 'current-password'}
                                    label={t('site.password')}
                                    minLength={register ? 8 : undefined}
                                    onChange={(e) => setPassword(e.currentTarget.value)}
                                    required
                                    value={password}
                                />
                            </>
                        )}
                        {error && (
                            <Text c="red" role="alert" size="sm">
                                {error}
                            </Text>
                        )}
                        <Button fullWidth loading={loading} type="submit">
                            {t(register ? 'site.register' : 'common.login')}
                        </Button>
                        {(!local || settings.REGISTRATION_ENABLED) && (
                            <Button
                                onClick={() => {
                                    if (local) setRegister(!register);
                                    else setAdmin(!admin);
                                    setTwoFactor(false);
                                    setPassword('');
                                    setError('');
                                }}
                                size="compact-sm"
                                variant="subtle"
                            >
                                {t(
                                    local
                                        ? register
                                            ? 'common.login'
                                            : 'site.register'
                                        : admin
                                          ? 'site.centralLogin'
                                          : 'site.adminLogin',
                                )}
                            </Button>
                        )}
                    </Stack>
                </form>
            </Paper>
        </Center>
    );
}
