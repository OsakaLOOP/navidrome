import { InfiniteData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { EntityKind } from './entity-panel';

import { EmojiPicker, EmojiText, useDiscussionEmoji } from './discussion-emoji';
import styles from './discussion-panel.module.css';
import { isRoomActive, useRoomActive } from './room';
import { siteApi } from './site-api';

import { api } from '/@/renderer/api';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { useAuthStore, usePlayerSong } from '/@/renderer/store';
import { usePlayerStoreBase } from '/@/renderer/store/player.store';
import { useTimestampStoreBase } from '/@/renderer/store/timestamp.store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Button } from '/@/shared/components/button/button';
import { Checkbox } from '/@/shared/components/checkbox/checkbox';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { Modal } from '/@/shared/components/modal/modal';
import { Popover } from '/@/shared/components/popover/popover';
import { Skeleton } from '/@/shared/components/skeleton/skeleton';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';
import { Textarea } from '/@/shared/components/textarea/textarea';

type Comment = Quote & {
    canDelete: boolean;
    createdAt: string;
    hasReplies: boolean;
    liked: boolean;
    likes: number;
    parent: null | Quote;
    position: null | number;
    userId: string;
};
type Discussion = {
    commentCount?: number;
    comments: Comment[];
    favoriteCount?: number;
    next?: null | number;
    publicCount?: number;
    root?: number;
};
type Props = {
    actions?: ReactNode;
    children?: ReactNode;
    id: string;
    kind: EntityKind;
    player?: boolean;
};
type Quote = { body: string; deleted: boolean; id: number; name: string };
const limit = 4000;

export function DiscussionPanel(props: Props) {
    const server = useAuthStore((state) => state.currentServer);
    if (window.SERVER_NAME !== 'ndFork' || !server) return null;
    return (
        <Discussion key={`${server.id}:${server.userId}:${props.kind}:${props.id}`} {...props} />
    );
}

export function useDiscussionCount(songId?: string) {
    const server = useAuthStore((state) => state.currentServer);
    const query = useQuery({
        enabled: window.SERVER_NAME === 'ndFork' && Boolean(server && songId),
        queryFn: () =>
            siteApi.request<{ count: number }>(
                `/site/discussion/song/${encodeURIComponent(songId!)}/count`,
            ),
        queryKey: ['site', 'discussion-count', server?.id, server?.userId, songId],
        staleTime: 30_000,
    });
    return query.data?.count;
}

function Discussion({ actions, children, id, kind, player }: Props) {
    const { i18n, t } = useTranslation();
    const server = useAuthStore((state) => state.currentServer);
    const client = useQueryClient();
    const playback = usePlayer();
    const current = usePlayerSong();
    const shared = useRoomActive();
    const heading = useId();
    const input = useRef<HTMLTextAreaElement>(null);
    const items = useRef(new Map<number, HTMLElement>());
    const [body, setBody] = useState('');
    const [now, setNow] = useState(Date.now);
    const [preview, setPreview] = useState(false);
    const [reply, setReply] = useState<Comment | null>(null);
    const [editing, setEditing] = useState<Comment | null>(null);
    const [reporting, setReporting] = useState<Comment | null>(null);
    const [reason, setReason] = useState('');
    const [deleting, setDeleting] = useState<Comment | null>(null);
    const [anchor, setAnchor] = useState<null | { comment: Comment; root: number }>(null);
    const [expanded, setExpanded] = useState<number>();
    const [ordering, setOrdering] = useState<'hot' | 'latest' | 'timed'>('latest');
    const [highlight, setHighlight] = useState<number>();
    const [busy, setBusy] = useState<string>();
    const likesInFlight = useRef(new Set<number>());
    const [pendingLikes, setPendingLikes] = useState<Set<number>>(new Set());
    const [composerError, setComposerError] = useState('');
    const [notice, setNotice] = useState<{ error: boolean; text: string }>();
    const [position, setPosition] = useState<number>();
    const [menu, setMenu] = useState<number>();
    const [showPeople, setShowPeople] = useState(false);
    const emoji = useDiscussionEmoji();
    const emojiIndex = emoji.data?.index;
    const path = `/site/discussion/${kind}/${encodeURIComponent(id)}`;
    const key = ['site', 'discussion', server?.id, server?.userId, kind, id];
    const query = useInfiniteQuery({
        getNextPageParam: (last: Discussion) => last.next ?? undefined,
        initialPageParam: 0,
        queryFn: ({ pageParam }): Promise<Discussion> =>
            siteApi.request(
                `${path}?${ordering === 'hot' ? `sort=hot&offset=${pageParam}` : `${ordering === 'timed' ? 'timed=1&' : ''}${pageParam ? `before=${pageParam}` : ''}`}`,
            ),
        queryKey: [...key, ordering],
    });
    const comments = [
        ...new Map(
            query.data?.pages
                .flatMap((page) => page.comments)
                .map((comment) => [comment.id, comment]),
        ).values(),
    ];
    const first = query.data?.pages[0];
    const threadId = anchor?.root ?? expanded;
    const thread = useInfiniteQuery({
        enabled: Boolean(threadId),
        getNextPageParam: (last: Discussion) => last.next ?? undefined,
        initialPageParam: 0,
        queryFn: ({ pageParam }): Promise<Discussion> =>
            siteApi.request(`${path}?thread=${threadId}&offset=${pageParam}`),
        queryKey: [...key, 'thread', threadId],
    });
    const root = useInfiniteQuery({
        enabled: Boolean(anchor?.root),
        getNextPageParam: () => undefined,
        initialPageParam: 0,
        queryFn: (): Promise<Discussion> => siteApi.request(`${path}?comment=${anchor?.root}`),
        queryKey: [...key, 'root', anchor?.root],
    });
    const people = useInfiniteQuery({
        enabled: showPeople,
        getNextPageParam: (last: {
            next?: null | number;
            people: { id: string; name: string }[];
        }) => last.next ?? undefined,
        initialPageParam: 0,
        queryFn: ({ pageParam }) =>
            siteApi.request<{ next?: null | number; people: { id: string; name: string }[] }>(
                `${path}/people?offset=${pageParam}`,
            ),
        queryKey: [...key, 'people'],
    });
    const canAttach = kind === 'song' && current?.id === id;
    const length = Array.from(body).length;
    const date = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
        dateStyle: 'medium',
        timeStyle: 'short',
    });
    const relative = new Intl.RelativeTimeFormat(i18n.resolvedLanguage, { numeric: 'auto' });
    const [published, setPublished] = useState<number>();
    const operations = useRef(new Set<string>());
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 30_000);
        return () => window.clearInterval(timer);
    }, []);
    useEffect(() => {
        if (highlight === undefined) return;
        const timer = window.setTimeout(() => setHighlight(undefined), 2500);
        return () => window.clearTimeout(timer);
    }, [highlight]);
    useEffect(() => {
        if (published === undefined) return;
        const element = items.current.get(published);
        if (!element) return;
        element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        setHighlight(published);
        setPublished(undefined);
    }, [published, query.data, thread.data]);

    const act = async (operation: string, run: () => Promise<unknown>, done?: () => void) => {
        if (operations.current.has(operation)) return;
        operations.current.add(operation);
        const composer = operation === 'post';
        if (composer || operation === 'delete' || operation === 'report') setBusy(operation);
        setNotice(undefined);
        if (operation === 'post') setComposerError('');
        try {
            await run();
            done?.();
        } catch (error) {
            const message = (error as Error).message;
            if (operation === 'post') setComposerError(message);
            else setNotice({ error: true, text: message });
        } finally {
            operations.current.delete(operation);
            setBusy((current) => (current === operation ? undefined : current));
        }
    };
    const refresh = () => {
        void client.invalidateQueries({
            queryKey: ['site', 'discussion-count', server?.id, server?.userId, id],
        });
        return client.invalidateQueries({ queryKey: key });
    };
    const patchLike = (comment: Comment, liked: boolean, count: number) => {
        client.setQueriesData<InfiniteData<Discussion>>(
            { queryKey: key },
            (data) =>
                data && {
                    ...data,
                    pages: data.pages.map((page) =>
                        !page.comments
                            ? page
                            : {
                                  ...page,
                                  comments: page.comments.map((item) =>
                                      item.id === comment.id
                                          ? { ...item, liked, likes: count }
                                          : item,
                                  ),
                              },
                    ),
                },
        );
        setAnchor((current) =>
            current?.comment.id === comment.id
                ? { ...current, comment: { ...current.comment, liked, likes: count } }
                : current,
        );
    };
    const like = async (comment: Comment) => {
        if (likesInFlight.current.has(comment.id)) return;
        likesInFlight.current.add(comment.id);
        setPendingLikes(new Set(likesInFlight.current));
        patchLike(comment, !comment.liked, comment.likes + (comment.liked ? -1 : 1));
        try {
            const result = await siteApi.request<{ liked: boolean; likes: number }>(
                `/site/comment/${comment.id}/like`,
                { liked: !comment.liked },
                'PUT',
            );
            patchLike(comment, result.liked, result.likes);
        } catch (error) {
            patchLike(comment, comment.liked, comment.likes);
            setNotice({ error: true, text: (error as Error).message });
        } finally {
            likesInFlight.current.delete(comment.id);
            setPendingLikes(new Set(likesInFlight.current));
        }
    };
    const publish = () => {
        if (busy || !body.trim() || length > limit) return;
        void act(
            'post',
            async () => {
                if (editing) {
                    await siteApi.request(`/site/comment/${editing.id}`, { body }, 'PUT');
                    setPublished(editing.id);
                    return;
                }
                const posted = await siteApi.request<{ id: number }>(path, {
                    body,
                    parentId: reply?.id,
                    position,
                });
                if (reply) {
                    const result = await siteApi
                        .request<Discussion>(`${path}?comment=${posted.id}`)
                        .catch(() => undefined);
                    if (result?.root && result.comments[0]) {
                        if (items.current.has(result.root) && !thread.hasNextPage) {
                            setExpanded(result.root);
                            setPublished(posted.id);
                        } else {
                            setAnchor({ comment: result.comments[0], root: result.root });
                            setHighlight(posted.id);
                        }
                    }
                } else {
                    setOrdering('latest');
                    setPublished(posted.id);
                }
            },
            () => {
                setBody('');
                setPreview(false);
                setReply(null);
                setEditing(null);
                setPosition(undefined);
                setNotice({ error: false, text: t('discussion.posted') });
                void refresh();
            },
        );
    };
    const insertEmoji = (token: string) => {
        const start = input.current?.selectionStart ?? body.length;
        const end = input.current?.selectionEnd ?? start;
        setBody(body.slice(0, start) + token + body.slice(end));
        setPreview(false);
        requestAnimationFrame(() => {
            input.current?.focus();
            input.current?.setSelectionRange(start + token.length, start + token.length);
        });
    };
    const locate = (quote: Quote) => {
        const element = items.current.get(quote.id);
        if (element) {
            setHighlight(quote.id);
            element.focus({ preventScroll: true });
            element.scrollIntoView({ block: 'nearest' });
        } else {
            void act('quote', async () => {
                const result = await siteApi.request<Discussion>(`${path}?comment=${quote.id}`);
                if (!result.comments[0]) throw new Error(t('discussion.quoteUnavailable'));
                setAnchor({ comment: result.comments[0], root: result.root ?? quote.id });
            });
        }
    };
    const jump = (time: number) => {
        void act('seek', async () => {
            if (usePlayerStoreBase.getState().getCurrentSong()?.id === id) {
                usePlayerStoreBase.getState().mediaSeekToTimestamp(time);
                return;
            }
            const song = await api.controller.getSongDetail({
                apiClientProps: { serverId: server?.id },
                query: { id },
            });
            if (isRoomActive()) throw new Error(t('discussion.sharedSeek'));
            playback.setQueue([song], 0, time);
        });
    };
    const renderQuote = (quote: Quote) => (
        <button className={styles.quote} onClick={() => locate(quote)} type="button">
            <span className={styles.quoteName}>
                {quote.deleted ? t('site.deleted') : quote.name || t('discussion.formerUser')}
            </span>
            {!quote.deleted && (
                <span className={styles.quoteBody}>
                    <EmojiText index={emojiIndex} text={quote.body} />
                </span>
            )}
        </button>
    );
    const renderCard = (comment: Comment, inDialog = false) => {
        const name = comment.name || t('discussion.formerUser');
        const created = new Date(comment.createdAt);
        const minutes = Math.max(0, Math.floor((now - created.valueOf()) / 60000));
        const foreignSong = shared && current?.id !== id;
        return (
            <article
                className={styles.comment}
                data-highlight={highlight === comment.id}
                key={comment.id}
                ref={
                    inDialog
                        ? undefined
                        : (element) => {
                              if (element) items.current.set(comment.id, element);
                              else items.current.delete(comment.id);
                          }
                }
                tabIndex={-1}
            >
                <span
                    aria-hidden="true"
                    className={styles.avatar}
                    data-color={(comment.userId.charCodeAt(0) || 0) % 4}
                >
                    {Array.from(name)[0]?.toLocaleUpperCase()}
                </span>
                <div className={styles.content}>
                    <div className={styles.byline}>
                        {comment.userId ? (
                            <Link
                                className={styles.author}
                                to={`/community/profile/${comment.userId}`}
                            >
                                {name}
                            </Link>
                        ) : (
                            <span className={styles.author}>{name}</span>
                        )}
                        <time
                            dateTime={comment.createdAt}
                            title={
                                Number.isNaN(created.valueOf()) ? undefined : date.format(created)
                            }
                        >
                            {Number.isNaN(created.valueOf())
                                ? comment.createdAt
                                : minutes >= 0 && minutes < 60
                                  ? relative.format(-minutes, 'minute')
                                  : minutes >= 60 && minutes < 1440
                                    ? relative.format(-Math.floor(minutes / 60), 'hour')
                                    : date.format(created)}
                        </time>
                    </div>
                    {comment.parent && renderQuote(comment.parent)}
                    <p className={comment.deleted ? styles.deleted : styles.body}>
                        {comment.deleted ? (
                            t('site.deleted')
                        ) : (
                            <EmojiText index={emojiIndex} text={comment.body} />
                        )}
                    </p>
                    {!comment.deleted && (
                        <Group gap="xs" wrap="wrap">
                            {comment.position != null && (
                                <Button
                                    disabled={busy === 'seek' || foreignSong}
                                    leftSection={<Icon icon="duration" size="xs" />}
                                    onClick={() => jump(comment.position!)}
                                    size="compact-sm"
                                    title={
                                        foreignSong
                                            ? t('discussion.sharedSeek')
                                            : t('discussion.seek', {
                                                  time: playbackTime(comment.position),
                                              })
                                    }
                                    variant="light"
                                >
                                    {playbackTime(comment.position)}
                                </Button>
                            )}
                            <Button
                                aria-label={t(comment.liked ? 'discussion.unlike' : 'site.like')}
                                aria-pressed={comment.liked}
                                disabled={pendingLikes.has(comment.id)}
                                leftSection={
                                    <Icon
                                        fill={comment.liked ? 'primary' : 'default'}
                                        icon="favorite"
                                        size="sm"
                                    />
                                }
                                onClick={() => void like(comment)}
                                size="compact-sm"
                                variant={comment.liked ? 'light' : 'subtle'}
                            >
                                {comment.likes || t('site.like')}
                            </Button>
                            <Button
                                onClick={() => {
                                    setAnchor(null);
                                    setPreview(false);
                                    setEditing(null);
                                    setReply(comment);
                                    requestAnimationFrame(() => input.current?.focus());
                                }}
                                size="compact-sm"
                                variant="subtle"
                            >
                                {t('site.reply')}
                            </Button>
                        </Group>
                    )}
                </div>
                {!comment.deleted && (
                    <Popover
                        onChange={(open) => setMenu(open ? comment.id : undefined)}
                        opened={menu === comment.id}
                        position="bottom-end"
                    >
                        <Popover.Target>
                            <ActionIcon
                                aria-label={t('discussion.options')}
                                icon="ellipsisHorizontal"
                                onClick={() =>
                                    setMenu(menu === comment.id ? undefined : comment.id)
                                }
                                tooltip={{ label: t('discussion.options') }}
                                variant="subtle"
                            />
                        </Popover.Target>
                        <Popover.Dropdown>
                            {comment.userId === server?.userId ? (
                                <Button
                                    onClick={() => {
                                        setMenu(undefined);
                                        setAnchor(null);
                                        setEditing(comment);
                                        setReply(null);
                                        setPreview(false);
                                        setBody(comment.body);
                                        requestAnimationFrame(() => input.current?.focus());
                                    }}
                                    size="compact-sm"
                                    variant="subtle"
                                >
                                    {t('common.edit')}
                                </Button>
                            ) : (
                                <Button
                                    onClick={() => {
                                        setMenu(undefined);
                                        setReason('');
                                        setReporting(comment);
                                    }}
                                    size="compact-sm"
                                    variant="subtle"
                                >
                                    {t('discussion.report')}
                                </Button>
                            )}
                            {comment.canDelete && (
                                <Button
                                    color="red"
                                    onClick={() => {
                                        setMenu(undefined);
                                        setDeleting(comment);
                                    }}
                                    size="compact-sm"
                                    variant="subtle"
                                >
                                    {t('site.delete')}
                                </Button>
                            )}
                        </Popover.Dropdown>
                    </Popover>
                )}
            </article>
        );
    };
    const modalHandlers = (close: () => void) => ({ close, open: () => undefined, toggle: close });
    const threadItems = thread.data?.pages.flatMap((page) => page.comments) ?? [];
    const renderThread = (dialog = false) => (
        <Stack className={styles.thread} gap="xs">
            {thread.isPending && <Skeleton height={42} />}
            {thread.isError && (
                <Button onClick={() => void thread.refetch()}>{t('discussion.retry')}</Button>
            )}
            {threadItems
                .filter((comment) => !dialog || comment.id !== anchor?.comment.id)
                .map((comment) => renderCard(comment, dialog))}
            {thread.hasNextPage && (
                <Button
                    loading={thread.isFetchingNextPage}
                    onClick={() => void thread.fetchNextPage()}
                    size="compact-sm"
                    variant="subtle"
                >
                    {t('site.more')}
                </Button>
            )}
        </Stack>
    );
    return (
        <section
            aria-labelledby={heading}
            className={`${styles.discussion}${player ? ` ${styles.inPlayer}` : ''}`}
        >
            <header className={styles.header}>
                <Group gap="sm">
                    <Text component="h2" fw={700} id={heading} size="xl">
                        {t('site.discussion')}
                    </Text>
                    {first && <span className={styles.count}>{first.commentCount ?? 0}</span>}
                </Group>
                {actions}
            </header>
            {children}
            <form
                className={styles.composer}
                onSubmit={(event) => {
                    event.preventDefault();
                    publish();
                }}
            >
                <span aria-hidden="true" className={styles.avatar}>
                    {Array.from(server?.username ?? '?')[0]?.toLocaleUpperCase()}
                </span>
                <Stack className={styles.content} gap="xs">
                    {editing && (
                        <Group gap="xs">
                            <Text size="sm">{t('common.edit')}</Text>
                            <ActionIcon
                                aria-label={t('site.cancel')}
                                icon="x"
                                onClick={() => {
                                    setEditing(null);
                                    setBody('');
                                }}
                                variant="subtle"
                            />
                        </Group>
                    )}
                    {reply && (
                        <Group justify="space-between" wrap="nowrap">
                            <Text size="sm" truncate>
                                {t('site.replyTo', {
                                    name: reply.name || t('discussion.formerUser'),
                                })}
                            </Text>
                            <ActionIcon
                                aria-label={t('site.cancel')}
                                icon="x"
                                onClick={() => setReply(null)}
                                variant="subtle"
                            />
                        </Group>
                    )}
                    <div className={styles.editorHeader}>
                        <Group gap="md">
                            <button
                                aria-pressed={!preview}
                                className={styles.editorMode}
                                onClick={() => setPreview(false)}
                                type="button"
                            >
                                {t('discussion.write')}
                            </button>
                            <button
                                aria-pressed={preview}
                                className={styles.editorMode}
                                onClick={() => setPreview(true)}
                                type="button"
                            >
                                {t('common.preview')}
                            </button>
                        </Group>
                        <EmojiPicker
                            disabled={busy === 'post'}
                            emoji={emoji}
                            onSelect={insertEmoji}
                        />
                    </div>
                    <div hidden={preview}>
                        <Textarea
                            aria-label={t('site.writeComment')}
                            autosize
                            maxRows={7}
                            minRows={2}
                            onChange={(event) => setBody(event.currentTarget.value)}
                            onKeyDown={(event) => {
                                if (
                                    event.key === 'Enter' &&
                                    (event.ctrlKey || event.metaKey) &&
                                    !event.nativeEvent.isComposing
                                ) {
                                    event.preventDefault();
                                    publish();
                                }
                            }}
                            placeholder={t('site.writeComment')}
                            ref={input}
                            value={body}
                        />
                    </div>
                    {(preview || body.includes('(')) && (
                        <div className={styles.preview}>
                            {body.trim() ? (
                                <EmojiText index={emojiIndex} text={body} />
                            ) : (
                                <Text c="dimmed" size="sm">
                                    {t('discussion.emptyPreview')}
                                </Text>
                            )}
                        </div>
                    )}
                    {(composerError || length > limit) && (
                        <Text c="red" role="alert" size="xs">
                            {composerError || t('discussion.tooLong')}
                        </Text>
                    )}
                    <div className={styles.composeActions}>
                        <Group gap="xs">
                            {!editing && (canAttach || position != null) && (
                                <Checkbox
                                    checked={position != null}
                                    label={
                                        position != null
                                            ? playbackTime(position)
                                            : t('site.attachTime')
                                    }
                                    onChange={(event) =>
                                        setPosition(
                                            event.currentTarget.checked
                                                ? useTimestampStoreBase.getState().timestamp
                                                : undefined,
                                        )
                                    }
                                    size="xs"
                                />
                            )}
                            {!editing && canAttach && position != null && (
                                <Button
                                    onClick={() =>
                                        setPosition(useTimestampStoreBase.getState().timestamp)
                                    }
                                    size="compact-xs"
                                    variant="subtle"
                                >
                                    {t('discussion.captureTime')}
                                </Button>
                            )}
                        </Group>
                        <Group gap="sm" wrap="nowrap">
                            {length > 0 && (
                                <Text c={length > limit ? 'red' : 'dimmed'} size="xs">
                                    {length}/{limit}
                                </Text>
                            )}
                            <Button
                                disabled={Boolean(busy) || !body.trim() || length > limit}
                                loading={busy === 'post'}
                                size="compact-sm"
                                type="submit"
                            >
                                {t(editing ? 'common.save' : reply ? 'site.reply' : 'site.publish')}
                            </Button>
                        </Group>
                    </div>
                </Stack>
            </form>
            {notice && (
                <Text
                    c={notice.error ? 'red' : 'dimmed'}
                    role={notice.error ? 'alert' : 'status'}
                    size="sm"
                >
                    {notice.text}
                </Text>
            )}
            <div className={styles.listHeader}>
                <Group gap={4}>
                    {(kind === 'song'
                        ? (['latest', 'hot', 'timed'] as const)
                        : (['latest', 'hot'] as const)
                    ).map((item) => (
                        <Button
                            aria-pressed={ordering === item}
                            key={item}
                            onClick={() => {
                                setOrdering(item);
                                setExpanded(undefined);
                            }}
                            size="compact-sm"
                            variant={ordering === item ? 'light' : 'subtle'}
                        >
                            {t(`discussion.${item}`)}
                        </Button>
                    ))}
                </Group>
                {!player && Boolean(first?.favoriteCount) && (
                    <Button
                        disabled={!first?.publicCount}
                        leftSection={<Icon icon="favorite" size="xs" />}
                        onClick={() => setShowPeople(true)}
                        size="compact-xs"
                        variant="subtle"
                    >
                        {t('site.favoriteCount', { count: first?.favoriteCount })}
                    </Button>
                )}
            </div>
            {query.isPending && (
                <Stack aria-label={t('discussion.loading')} gap="md" role="status">
                    <Skeleton height={48} />
                    <Skeleton height={48} />
                </Stack>
            )}
            {query.isError && !first && (
                <Stack align="center" className={styles.empty} gap="xs">
                    <Text role="alert" size="sm">
                        {t('discussion.loadFailed')}
                    </Text>
                    <Button onClick={() => void query.refetch()} size="compact-sm" variant="light">
                        {t('discussion.retry')}
                    </Button>
                </Stack>
            )}
            {first && !comments.length && (
                <Stack align="center" className={styles.empty} gap={4}>
                    <Icon icon="discussion" size="lg" />
                    <Text fw={600} size="sm">
                        {t('discussion.empty')}
                    </Text>
                    <Text c="dimmed" size="sm">
                        {t('discussion.emptyHint')}
                    </Text>
                </Stack>
            )}
            {comments.map((comment) => (
                <div key={comment.id}>
                    {renderCard(comment)}
                    {comment.hasReplies && ordering !== 'timed' && (
                        <Button
                            aria-expanded={expanded === comment.id}
                            onClick={() =>
                                setExpanded(expanded === comment.id ? undefined : comment.id)
                            }
                            size="compact-sm"
                            variant="subtle"
                        >
                            {t('discussion.replies')}
                        </Button>
                    )}
                    {expanded === comment.id && !anchor && renderThread()}
                </div>
            ))}
            {query.hasNextPage && (
                <Button
                    loading={query.isFetchingNextPage}
                    onClick={() => void query.fetchNextPage()}
                    size="compact-sm"
                    variant="subtle"
                >
                    {t(query.isFetchNextPageError ? 'discussion.retryMore' : 'site.more')}
                </Button>
            )}
            {deleting && (
                <Modal
                    handlers={modalHandlers(() => setDeleting(null))}
                    opened
                    title={t('discussion.deleteTitle')}
                >
                    <Stack>
                        <Text size="sm">{t('discussion.deleteHint')}</Text>
                        <Group justify="flex-end">
                            <Button onClick={() => setDeleting(null)} variant="subtle">
                                {t('site.cancel')}
                            </Button>
                            <Button
                                color="red"
                                loading={busy === 'delete'}
                                onClick={() =>
                                    void act(
                                        'delete',
                                        () =>
                                            siteApi.request(
                                                `/site/comment/${deleting.id}`,
                                                undefined,
                                                'DELETE',
                                            ),
                                        () => {
                                            if (reply?.id === deleting.id) setReply(null);
                                            setDeleting(null);
                                            setAnchor(null);
                                            void refresh();
                                        },
                                    )
                                }
                            >
                                {t('site.delete')}
                            </Button>
                        </Group>
                    </Stack>
                </Modal>
            )}
            {anchor && (
                <Modal
                    handlers={modalHandlers(() => setAnchor(null))}
                    opened
                    title={t('discussion.original')}
                >
                    {root.data?.pages[0]?.comments[0] &&
                        anchor.root !== anchor.comment.id &&
                        renderCard(root.data.pages[0].comments[0], true)}
                    {renderCard(anchor.comment, true)}
                    {renderThread(true)}
                </Modal>
            )}
            {showPeople && (
                <Modal
                    handlers={modalHandlers(() => setShowPeople(false))}
                    opened
                    title={t('site.favoriteCount', { count: first?.favoriteCount })}
                >
                    <Group gap="xs">
                        {people.data?.pages
                            .flatMap((page) => page.people)
                            .map((person) => (
                                <Button
                                    component={Link}
                                    key={person.id}
                                    onClick={() => setShowPeople(false)}
                                    size="compact-sm"
                                    to={`/community/profile/${person.id}`}
                                    variant="light"
                                >
                                    {person.name}
                                </Button>
                            ))}
                    </Group>
                    {people.isPending && <Skeleton height={32} />}
                    {people.isError && (
                        <Button onClick={() => void people.refetch()}>
                            {t('discussion.retry')}
                        </Button>
                    )}
                    {people.hasNextPage && (
                        <Button
                            loading={people.isFetchingNextPage}
                            onClick={() => void people.fetchNextPage()}
                            variant="subtle"
                        >
                            {t('site.more')}
                        </Button>
                    )}
                </Modal>
            )}
            {reporting && (
                <Modal
                    handlers={modalHandlers(() => setReporting(null))}
                    opened
                    title={t('discussion.report')}
                >
                    <Stack>
                        <Textarea
                            label={t('discussion.reason')}
                            maxLength={500}
                            onChange={(event) => setReason(event.currentTarget.value)}
                            value={reason}
                        />
                        {notice?.error && busy !== 'report' && (
                            <Text c="red" role="alert">
                                {notice.text}
                            </Text>
                        )}
                        <Button
                            disabled={!reason.trim()}
                            loading={busy === 'report'}
                            onClick={() =>
                                void act(
                                    'report',
                                    () =>
                                        siteApi.request(`/site/comment/${reporting.id}/report`, {
                                            reason,
                                        }),
                                    () => {
                                        setReporting(null);
                                        setNotice({ error: false, text: t('discussion.reported') });
                                    },
                                )
                            }
                        >
                            {t('discussion.report')}
                        </Button>
                    </Stack>
                </Modal>
            )}
        </section>
    );
}

function playbackTime(seconds: number) {
    return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
