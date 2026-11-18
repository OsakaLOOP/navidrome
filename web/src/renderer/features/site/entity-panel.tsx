import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { DiscussionPanel } from './discussion-panel';
import { siteApi } from './site-api';

import { useAuthStore } from '/@/renderer/store';
import { Button } from '/@/shared/components/button/button';
import { Group } from '/@/shared/components/group/group';
import { Select } from '/@/shared/components/select/select';
import { Stack } from '/@/shared/components/stack/stack';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { Text } from '/@/shared/components/text/text';
import { Textarea } from '/@/shared/components/textarea/textarea';
import { toast } from '/@/shared/components/toast/toast';

export type EntityKind = 'album' | 'artist' | 'song';
type Metadata = {
    fields: string[];
    item: Record<string, unknown>;
    overrides: Record<string, unknown>;
    source: Record<string, unknown>;
};

export function EntityPanel({ id, kind }: { id: string; kind: EntityKind }) {
    const { t } = useTranslation();
    const isAdmin = useAuthStore((state) => state.currentServer?.isAdmin);
    const [editor, setEditor] = useState(false);
    return (
        <DiscussionPanel
            actions={
                isAdmin && (
                    <Button
                        aria-expanded={editor}
                        onClick={() => setEditor(!editor)}
                        size="compact-sm"
                        variant="subtle"
                    >
                        {t('site.metadata')}
                    </Button>
                )
            }
            id={id}
            kind={kind}
        >
            {editor && <MetadataEditor id={id} kind={kind} />}
        </DiscussionPanel>
    );
}

export function MetadataEditor({ id, kind }: { id: string; kind: EntityKind }) {
    const { t } = useTranslation();
    const client = useQueryClient();
    const [mode, setMode] = useState<'edit' | 'override'>('override');
    const [draft, setDraft] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const { data } = useQuery({
        queryFn: () => siteApi.request<Metadata>(`/site/metadata/${kind}/${id}`),
        queryKey: ['site', 'metadata', kind, id],
    });

    const save = async (restore: string[] = []) => {
        setBusy(true);
        setError('');
        try {
            const fields = Object.fromEntries(
                Object.entries(restore.length ? {} : draft).map(([key, value]) => [
                    key,
                    ['discNumber', 'maxYear', 'minYear', 'trackNumber', 'year'].includes(key)
                        ? Number(value)
                        : key === 'participants'
                          ? JSON.parse(value)
                          : value,
                ]),
            );
            await siteApi.request(`/site/metadata/${kind}/${id}`, { fields, mode, restore }, 'PUT');
            setDraft({});
            await client.invalidateQueries();
            toast.success({ message: t('site.saved') });
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    };
    return (
        <Stack gap="md">
            <Select
                data={[
                    { label: t('site.override'), value: 'override' },
                    ...(kind === 'artist' ? [] : [{ label: t('site.editTags'), value: 'edit' }]),
                ]}
                label={t('site.mode')}
                onChange={(v) => {
                    setMode(v as 'edit' | 'override');
                    setDraft({});
                }}
                value={mode}
            />
            <Text c="dimmed" size="sm">
                {t(mode === 'override' ? 'site.overrideHelp' : 'site.editHelp')}
            </Text>
            {data?.fields
                .filter((f) => !['albumArtistId', 'artistId', 'participants'].includes(f))
                .map((field) => {
                    const overridden = Object.hasOwn(data.overrides, field);
                    const value =
                        draft[field] ??
                        displayValue(
                            field,
                            mode === 'edit'
                                ? data.source[field]
                                : (data.overrides[field] ?? data.source[field]),
                        );
                    const label = t(`site.field.${field}`, { defaultValue: field });
                    return (
                        <Stack gap={4} key={field}>
                            {['biography', 'comment', 'description', 'lyrics'].includes(field) ? (
                                <Textarea
                                    autosize
                                    label={label}
                                    maxRows={12}
                                    minRows={3}
                                    onChange={(e) =>
                                        setDraft({ ...draft, [field]: e.currentTarget.value })
                                    }
                                    value={value}
                                />
                            ) : (
                                <TextInput
                                    label={label}
                                    onChange={(e) =>
                                        setDraft({ ...draft, [field]: e.currentTarget.value })
                                    }
                                    value={value}
                                />
                            )}
                            {overridden && (
                                <Group justify="space-between">
                                    <Text c="dimmed" size="xs">
                                        {t('site.baseValue')}:{' '}
                                        {displayValue(field, data.source[field]).slice(0, 160)}
                                    </Text>
                                    <Button
                                        disabled={busy}
                                        onClick={() => void save([field])}
                                        size="compact-xs"
                                        variant="subtle"
                                    >
                                        {t('site.restoreField')}
                                    </Button>
                                </Group>
                            )}
                        </Stack>
                    );
                })}
            <Group>
                <Button component="label" loading={busy} variant="light">
                    {t('site.uploadCover')}
                    <input
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        hidden
                        onChange={async (e) => {
                            const file = e.currentTarget.files?.[0];
                            if (!file) return;
                            const server = useAuthStore.getState().currentServer;
                            setBusy(true);
                            setError('');
                            try {
                                const response = await fetch(
                                    `${server?.url}/site/cover/${kind}/${id}`,
                                    {
                                        body: file,
                                        headers: {
                                            'x-nd-authorization': `Bearer ${server?.ndCredential}`,
                                        },
                                        method: 'POST',
                                    },
                                );
                                if (!response.ok) throw new Error((await response.json()).message);
                                await client.invalidateQueries();
                            } catch (err) {
                                setError((err as Error).message);
                            } finally {
                                setBusy(false);
                            }
                        }}
                        type="file"
                    />
                </Button>
                <Button
                    disabled={busy}
                    onClick={async () => {
                        try {
                            await siteApi.request(`/site/cover/${kind}/${id}`, undefined, 'DELETE');
                            await client.invalidateQueries();
                        } catch (e) {
                            setError((e as Error).message);
                        }
                    }}
                    variant="subtle"
                >
                    {t('site.restoreCover')}
                </Button>
            </Group>
            {error && (
                <Text c="red" role="alert" size="sm">
                    {error}
                </Text>
            )}
            <Button
                disabled={!Object.keys(draft).length}
                loading={busy}
                onClick={() => void save()}
            >
                {t('site.save')}
            </Button>
        </Stack>
    );
}

function displayValue(field: string, value: unknown) {
    if (field === 'lyrics' && typeof value === 'string') {
        try {
            const lyrics = JSON.parse(value);
            return (
                lyrics[0]?.line
                    ?.map((l: { start?: number; value: string }) => {
                        if (l.start == null) return l.value;
                        const seconds = l.start / 1000;
                        return `[${Math.floor(seconds / 60)
                            .toString()
                            .padStart(
                                2,
                                '0',
                            )}:${(seconds % 60).toFixed(2).padStart(5, '0')}]${l.value}`;
                    })
                    .join('\n') || ''
            );
        } catch {
            return value;
        }
    }
    return value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
}
