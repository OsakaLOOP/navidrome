import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { EntityKind } from './entity-panel';

import { isRoomActive } from './room';
import { siteApi } from './site-api';

import { api } from '/@/renderer/api';
import { searchQueries } from '/@/renderer/features/search/api/search-api';
import { useAuthStore } from '/@/renderer/store';
import { usePlayerStoreBase } from '/@/renderer/store/player.store';
import { Button } from '/@/shared/components/button/button';
import { Group } from '/@/shared/components/group/group';
import { Modal } from '/@/shared/components/modal/modal';
import { MultiSelect } from '/@/shared/components/multi-select/multi-select';
import { Select } from '/@/shared/components/select/select';
import { Stack } from '/@/shared/components/stack/stack';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { Text } from '/@/shared/components/text/text';
import { Textarea } from '/@/shared/components/textarea/textarea';
import { useDebouncedValue } from '/@/shared/hooks/use-debounced-value';

type Fields = Record<string, unknown>;
type Lyric = { kind?: string; lang: string; line: LyricLine[]; synced: boolean };
type LyricLine = { start?: number; value: string };
type Metadata = {
    coverOverride: boolean;
    fields: string[];
    fileFields?: string[];
    files?: string[];
    overrides: Fields;
    revision: string;
    source: Fields;
};
type Mode = 'edit' | 'override';
type Selection = { id: string; name: string };
const numeric = new Set(['discNumber', 'fileYear', 'maxYear', 'minYear', 'trackNumber', 'year']);
const artistRoles: Record<string, string> = { albumArtist: 'albumartist', artist: 'artist' };

const display = (value: unknown) =>
    value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);

export function MetadataEditor(props: { id: string; kind: EntityKind }) {
    const server = useAuthStore((state) => state.currentServer);
    if (!server?.isAdmin) return null;
    return <Editor key={`${server.id}:${server.userId}:${props.kind}:${props.id}`} {...props} />;
}

function ArtistField({
    disabled,
    label,
    onChange,
    serverId,
    value,
}: {
    disabled: boolean;
    label: string;
    onChange: (artists: Selection[]) => void;
    serverId: string;
    value: Selection[];
}) {
    const { t } = useTranslation();
    const [search, setSearch] = useState('');
    const [term] = useDebouncedValue(search.trim(), 250);
    const results = useQuery(
        searchQueries.search({
            options: { enabled: Boolean(term) },
            query: { albumArtistLimit: 18, albumLimit: 0, query: term, songLimit: 0 },
            serverId,
        }),
    );
    const choices = new Map(value.map((artist) => [artist.id, artist.name]));
    for (const artist of results.data?.albumArtists ?? []) choices.set(artist.id, artist.name);
    const matches = [...choices.values()];
    const options = [...choices].map(([id, name]) => ({
        label:
            matches.filter((match) => match === name).length > 1
                ? `${name} · ${id.slice(0, 8)}`
                : name,
        value: id,
    }));
    if (
        term &&
        !results.isFetching &&
        !results.isError &&
        !matches.some((name) => name.toLocaleLowerCase() === term.toLocaleLowerCase())
    ) {
        options.push({
            label: t('metadataEditor.createArtist', { name: term }),
            value: `new:${term}`,
        });
    }
    return (
        <MultiSelect
            clearable
            data={options}
            disabled={disabled}
            filter={({ options }) => options}
            label={label}
            nothingFoundMessage={t(
                results.isFetching ? 'together.searching' : 'metadataEditor.noArtist',
            )}
            onChange={(ids) =>
                onChange(ids.map((id) => ({ id, name: choices.get(id) ?? id.slice(4) })))
            }
            onSearchChange={setSearch}
            searchable
            searchValue={search}
            value={value.map((artist) => artist.id)}
        />
    );
}

function Editor({ id, kind }: { id: string; kind: EntityKind }) {
    const { t } = useTranslation();
    const client = useQueryClient();
    const server = useAuthStore((state) => state.currentServer)!;
    const [mode, setMode] = useState<Mode>('override');
    const [drafts, setDrafts] = useState<Record<Mode, Record<string, string>>>({
        edit: {},
        override: {},
    });
    const [artists, setArtists] = useState<Record<string, Selection[]>>({});
    const [busy, setBusy] = useState(false);
    const [feedback, setFeedback] = useState<{ error: boolean; text: string }>();
    const [confirm, setConfirm] = useState<'cover' | 'files' | 'restoreCover'>();
    const [cover, setCover] = useState<File>();
    const [preview, setPreview] = useState<string>();
    const path = `/site/metadata/${kind}/${encodeURIComponent(id)}`;
    const coverPath = `/site/cover/${kind}/${encodeURIComponent(id)}`;
    const key = ['site', 'metadata', server.id, server.userId, kind, id];
    const query = useQuery({ queryFn: () => siteApi.request<Metadata>(path), queryKey: key });
    const data = query.data;
    const draft = drafts[mode];
    const change = (field: string, value: string) =>
        setDrafts((previous) => ({ ...previous, [mode]: { ...previous[mode], [field]: value } }));
    const fieldLabel = (field: string) =>
        t(field === 'fileYear' ? 'metadataEditor.fileYear' : `site.field.${field}`, {
            defaultValue: field,
        });

    useEffect(() => {
        const url = cover ? URL.createObjectURL(cover) : undefined;
        setPreview(url);
        return () => {
            if (url) URL.revokeObjectURL(url);
        };
    }, [cover]);

    const update = async (run: () => Promise<string | undefined>) => {
        setBusy(true);
        setFeedback(undefined);
        try {
            const message = await run();
            await client.invalidateQueries();
            setFeedback({ error: Boolean(message), text: message ?? t('site.saved') });
        } catch (error) {
            setFeedback({ error: true, text: (error as Error).message });
        } finally {
            setBusy(false);
        }
    };
    const save = (restore: string[] = []) =>
        void update(async () => {
            const fields: Fields = {};
            for (const [field, value] of Object.entries(restore.length ? {} : draft)) {
                if (numeric.has(field) && !/^\d{0,4}$/.test(value))
                    throw new Error(t('metadataEditor.number', { field: fieldLabel(field) }));
                fields[field] = numeric.has(field) ? Number(value) : value;
            }
            const chosen = Object.fromEntries(
                Object.entries(artists)
                    .filter(([field]) => Object.hasOwn(fields, field) && mode === 'override')
                    .map(([field, list]) => [field, list.map((artist) => artist.id)]),
            );
            const result = await siteApi.request<{ scanWarning?: string }>(
                path,
                {
                    artists: chosen,
                    fields,
                    files: mode === 'edit' ? data?.files : undefined,
                    mode,
                    restore,
                    revision: data?.revision ?? '',
                },
                'PUT',
            );
            setDrafts((previous) => ({
                ...previous,
                [mode]: restore.length
                    ? Object.fromEntries(
                          Object.entries(previous[mode]).filter(
                              ([field]) => !restore.includes(field),
                          ),
                      )
                    : {},
            }));
            setArtists((previous) =>
                restore.length
                    ? Object.fromEntries(
                          Object.entries(previous).filter(([field]) => !restore.includes(field)),
                      )
                    : mode === 'override'
                      ? {}
                      : previous,
            );
            setConfirm(undefined);
            return result?.scanWarning;
        });

    const saveCover = () =>
        void update(async () => {
            if (confirm === 'restoreCover') {
                await siteApi.request(coverPath, undefined, 'DELETE');
            } else if (cover) {
                const response = await fetch(`${server.url}${coverPath}`, {
                    body: cover,
                    credentials: 'include',
                    headers: { 'x-nd-authorization': `Bearer ${server.ndCredential}` },
                    method: 'POST',
                });
                if (!response.ok)
                    throw new Error((await response.json()).message || response.statusText);
            }
            setCover(undefined);
            setConfirm(undefined);
            return undefined;
        });

    if (query.isPending)
        return (
            <Text c="dimmed" role="status" size="sm">
                {t('metadataEditor.loading')}
            </Text>
        );
    if (!data)
        return (
            <Group>
                <Text c="red" role="alert" size="sm">
                    {query.error?.message}
                </Text>
                <Button onClick={() => void query.refetch()} size="compact-sm" variant="light">
                    {t('discussion.retry')}
                </Button>
            </Group>
        );
    const values = mode === 'override' ? { ...data.source, ...data.overrides } : data.source;
    const fields =
        mode === 'edit'
            ? (data.fileFields ?? [])
            : data.fields.filter(
                  (field) => !['albumArtistId', 'artistId', 'participants'].includes(field),
              );
    return (
        <Stack gap="md">
            <Select
                allowDeselect={false}
                data={[
                    { label: t('site.override'), value: 'override' },
                    ...(data.fileFields?.length
                        ? [{ label: t('site.editTags'), value: 'edit' }]
                        : []),
                ]}
                disabled={busy}
                label={t('site.mode')}
                onChange={(value) => {
                    if (value) setMode(value as Mode);
                }}
                value={mode}
            />
            <Text c="dimmed" size="sm">
                {t(mode === 'override' ? 'site.overrideHelp' : 'metadataEditor.fileHelp', {
                    count: data.files?.length ?? 0,
                })}
            </Text>
            {fields.map((field) => {
                const label = fieldLabel(field);
                const value = draft[field] ?? display(values[field]);
                const props = {
                    disabled: busy,
                    label,
                    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
                        change(field, event.currentTarget.value),
                    value,
                };
                const participantMap = values.participants as
                    | Record<string, Selection[]>
                    | undefined;
                return (
                    <Stack gap={4} key={field}>
                        {mode === 'override' && artistRoles[field] ? (
                            <ArtistField
                                disabled={busy}
                                label={label}
                                onChange={(selection) => {
                                    setArtists((previous) => ({ ...previous, [field]: selection }));
                                    change(
                                        field,
                                        selection.map((artist) => artist.name).join('; '),
                                    );
                                }}
                                serverId={server.id}
                                value={artists[field] ?? participantMap?.[artistRoles[field]] ?? []}
                            />
                        ) : field === 'lyrics' ? (
                            <LyricsField
                                disabled={busy}
                                id={id}
                                label={label}
                                onChange={(lyrics) => change(field, lyrics)}
                                serverId={server.id}
                                value={value}
                            />
                        ) : ['biography', 'comment', 'description'].includes(field) ? (
                            <Textarea {...props} autosize maxRows={6} minRows={2} />
                        ) : (
                            <TextInput
                                {...props}
                                inputMode={numeric.has(field) ? 'numeric' : undefined}
                            />
                        )}
                        {mode === 'override' && Object.hasOwn(data.overrides, field) && (
                            <Group justify="space-between">
                                <Text c="dimmed" size="xs">
                                    {t('site.baseValue')}
                                    {field !== 'lyrics'
                                        ? `: ${display(data.source[field]).slice(0, 150) || t('metadataEditor.emptyValue')}`
                                        : ''}
                                </Text>
                                <Button
                                    disabled={busy}
                                    onClick={() => save([field])}
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
            <Button
                disabled={
                    busy || !Object.keys(draft).length || (mode === 'edit' && !data.files?.length)
                }
                loading={busy && !confirm}
                onClick={() => (mode === 'edit' ? setConfirm('files') : save())}
            >
                {t(mode === 'edit' ? 'metadataEditor.review' : 'site.save')}
            </Button>
            {mode === 'override' && (
                <Group>
                    <Button component="label" disabled={busy} variant="light">
                        {t('site.uploadCover')}
                        <input
                            accept="image/png,image/jpeg,image/webp,image/gif"
                            disabled={busy}
                            hidden
                            onChange={(event) => {
                                const file = event.currentTarget.files?.[0];
                                event.currentTarget.value = '';
                                if (file) {
                                    setCover(file);
                                    setConfirm('cover');
                                    setFeedback(undefined);
                                }
                            }}
                            type="file"
                        />
                    </Button>
                    {data.coverOverride && (
                        <Button
                            disabled={busy}
                            onClick={() => setConfirm('restoreCover')}
                            variant="subtle"
                        >
                            {t('site.restoreCover')}
                        </Button>
                    )}
                </Group>
            )}
            {feedback && !confirm && (
                <Text
                    c={feedback.error ? 'red' : 'dimmed'}
                    role={feedback.error ? 'alert' : 'status'}
                    size="sm"
                >
                    {feedback.text}
                </Text>
            )}
            {confirm && (
                <Modal
                    handlers={{
                        close: () => {
                            if (!busy) setConfirm(undefined);
                        },
                        open: () => undefined,
                        toggle: () => undefined,
                    }}
                    opened
                    title={t(
                        confirm === 'files'
                            ? 'metadataEditor.review'
                            : confirm === 'cover'
                              ? 'site.uploadCover'
                              : 'site.restoreCover',
                    )}
                >
                    <Stack>
                        {confirm === 'files' && (
                            <>
                                <Text size="sm">
                                    {t('metadataEditor.confirmFiles', {
                                        count: data.files?.length ?? 0,
                                    })}
                                </Text>
                                <Text size="sm">
                                    {Object.keys(draft).map(fieldLabel).join(' · ')}
                                </Text>
                                <div
                                    style={{
                                        maxHeight: '12rem',
                                        overflow: 'auto',
                                        overflowWrap: 'anywhere',
                                    }}
                                >
                                    <ul>
                                        {data.files?.map((file, index) => (
                                            <li key={`${file}:${index}`}>{file}</li>
                                        ))}
                                    </ul>
                                </div>
                            </>
                        )}
                        {confirm === 'cover' && preview && (
                            <img
                                alt={t('metadataEditor.coverPreview')}
                                src={preview}
                                style={{ maxHeight: '55vh', objectFit: 'contain', width: '100%' }}
                            />
                        )}
                        {confirm === 'restoreCover' && (
                            <Text size="sm">{t('metadataEditor.restoreCover')}</Text>
                        )}
                        {feedback?.error && (
                            <Text c="red" role="alert" size="sm">
                                {feedback.text}
                            </Text>
                        )}
                        <Group justify="flex-end">
                            <Button
                                disabled={busy}
                                onClick={() => setConfirm(undefined)}
                                variant="subtle"
                            >
                                {t('site.cancel')}
                            </Button>
                            <Button
                                loading={busy}
                                onClick={confirm === 'files' ? () => save() : saveCover}
                            >
                                {t('site.save')}
                            </Button>
                        </Group>
                    </Stack>
                </Modal>
            )}
        </Stack>
    );
}

function LyricsField({
    disabled,
    id,
    label,
    onChange,
    serverId,
    value,
}: {
    disabled: boolean;
    id: string;
    label: string;
    onChange: (value: string) => void;
    serverId: string;
    value: string;
}) {
    const { t } = useTranslation();
    const [index, setIndex] = useState(0);
    const [preview, setPreview] = useState(false);
    const [error, setError] = useState('');
    let lyrics: Lyric[] = [];
    try {
        const parsed: unknown = JSON.parse(value);
        if (Array.isArray(parsed)) lyrics = parsed;
    } catch {
        lyrics = [];
    }
    const current = lyrics[index];
    const format = (ms: number) =>
        `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${((ms % 60000) / 1000).toFixed(3).padStart(6, '0')}`;
    const text =
        current?.line
            ?.map((line) =>
                line.start == null ? line.value : `[${format(line.start)}]${line.value}`,
            )
            .join('\n') ?? '';
    const change = (input: string) => {
        const line = input.split('\n').map((part) => {
            const timestamp = /^\[(\d+):(\d{2}(?:\.\d{1,3})?)\](.*)$/.exec(part);
            return timestamp
                ? {
                      start: Math.round((Number(timestamp[1]) * 60 + Number(timestamp[2])) * 1000),
                      value: timestamp[3],
                  }
                : { value: part };
        });
        const previousLines = current?.line ?? [];
        const updated = {
            ...current,
            lang: current?.lang ?? 'und',
            line: line.map((item, position) => {
                const previous = previousLines[position];
                return previous?.start === item.start && previous?.value === item.value
                    ? previous
                    : item;
            }),
            synced: line.some((item) => 'start' in item),
        };
        onChange(
            JSON.stringify(
                lyrics.length
                    ? lyrics.map((lyric, position) => (position === index ? updated : lyric))
                    : [updated],
            ),
        );
    };
    const seek = async (ms: number) => {
        setError('');
        try {
            if (usePlayerStoreBase.getState().getCurrentSong()?.id !== id) {
                if (isRoomActive()) throw new Error(t('discussion.sharedSeek'));
                const song = await api.controller.getSongDetail({
                    apiClientProps: { serverId },
                    query: { id },
                });
                if (isRoomActive()) throw new Error(t('discussion.sharedSeek'));
                usePlayerStoreBase.getState().setQueue([song], 0, ms / 1000);
            }
            usePlayerStoreBase.getState().mediaSeekToTimestamp(ms / 1000);
        } catch (error) {
            setError((error as Error).message);
        }
    };
    return (
        <Stack gap="xs">
            {lyrics.length > 1 && (
                <Select
                    allowDeselect={false}
                    data={lyrics.map((lyric, position) => ({
                        label: `${lyric.lang} · ${lyric.kind || t('metadataEditor.mainLyrics')} (${position + 1})`,
                        value: String(position),
                    }))}
                    label={t('metadataEditor.lyricVersion')}
                    onChange={(value) => setIndex(Number(value))}
                    value={String(index)}
                />
            )}
            <Textarea
                autosize
                disabled={disabled}
                label={label}
                maxRows={12}
                minRows={3}
                onChange={(event) => change(event.currentTarget.value)}
                value={text}
            />
            {current?.synced && (
                <Button
                    aria-expanded={preview}
                    onClick={() => setPreview(!preview)}
                    size="compact-xs"
                    variant="subtle"
                >
                    {t('metadataEditor.lyricPreview')}
                </Button>
            )}
            {preview && (
                <div style={{ maxHeight: '12rem', overflow: 'auto' }}>
                    {current?.line
                        .filter((line) => line.start != null)
                        .map((line, position) => (
                            <Group gap="xs" key={position}>
                                <Button
                                    onClick={() => void seek(line.start!)}
                                    size="compact-xs"
                                    variant="subtle"
                                >
                                    {format(line.start!)}
                                </Button>
                                <Text size="sm">{line.value}</Text>
                            </Group>
                        ))}
                </div>
            )}
            {error && (
                <Text c="red" role="alert" size="sm">
                    {error}
                </Text>
            )}
        </Stack>
    );
}
