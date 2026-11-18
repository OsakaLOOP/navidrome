import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { ReactNode, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { EntityKind } from './entity-panel';

import styles from './discussion-panel.module.css';
import { isRoomActive, useRoomActive } from './room';
import { siteApi } from './site-api';

import { api } from '/@/renderer/api';
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
    people?: { id: string; name: string }[];
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

function Discussion({ actions, children, id, kind, player }: Props) {
    const { i18n, t } = useTranslation();
    const server = useAuthStore((state) => state.currentServer);
    const client = useQueryClient();
    const current = usePlayerSong();
    const shared = useRoomActive();
    const heading = useId();
    const input = useRef<HTMLTextAreaElement>(null);
    const items = useRef(new Map<number, HTMLElement>());
    const [body, setBody] = useState('');
    const [reply, setReply] = useState<Comment | null>(null);
    const [deleting, setDeleting] = useState<Comment | null>(null);
    const [anchor, setAnchor] = useState<Comment | null>(null);
    const [highlight, setHighlight] = useState<number>();
    const [busy, setBusy] = useState<string>();
    const [composerError, setComposerError] = useState('');
    const [notice, setNotice] = useState<{ error: boolean; text: string }>();
    const [position, setPosition] = useState<number>();
    const [menu, setMenu] = useState<number>();
    const [showPeople, setShowPeople] = useState(false);
    const path = `/site/discussion/${kind}/${encodeURIComponent(id)}`;
    const key = ['site', 'discussion', server?.id, server?.userId, kind, id];
    const query = useInfiniteQuery({
        getNextPageParam: (last) => last.next ?? undefined,
        initialPageParam: 0,
        queryFn: ({ pageParam }) =>
            siteApi.request<Discussion>(`${path}${pageParam ? `?before=${pageParam}` : ''}`),
        queryKey: key,
    });
    const comments = query.data?.pages.flatMap((page) => page.comments) ?? [];
    const first = query.data?.pages[0];
    const canAttach = kind === 'song' && current?.id === id;
    const length = Array.from(body).length;
    const date = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
        dateStyle: 'medium',
        timeStyle: 'short',
    });

    const act = async (operation: string, run: () => Promise<unknown>, done?: () => void) => {
        setBusy(operation);
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
            setBusy(undefined);
        }
    };
    const refresh = () => client.invalidateQueries({ queryKey: key });
    const publish = () => {
        if (busy || !body.trim() || length > limit) return;
        void act(
            'post',
            () => siteApi.request(path, { body, parentId: reply?.id, position }),
            () => {
                setBody('');
                setReply(null);
                setPosition(undefined);
                setNotice({ error: false, text: t('discussion.posted') });
                void refresh();
            },
        );
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
                setAnchor(result.comments[0]);
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
            usePlayerStoreBase.getState().setQueue([song], 0, time);
            usePlayerStoreBase.getState().mediaSeekToTimestamp(time);
        });
    };
    const renderQuote = (quote: Quote) => (
        <button
            className={styles.quote}
            disabled={Boolean(busy)}
            onClick={() => locate(quote)}
            type="button"
        >
            <span className={styles.quoteName}>
                {quote.deleted ? t('site.deleted') : quote.name || t('discussion.formerUser')}
            </span>
            {!quote.deleted && <span className={styles.quoteBody}>{quote.body}</span>}
        </button>
    );
    const renderCard = (comment: Comment, inDialog = false) => {
        const name = comment.name || t('discussion.formerUser');
        const created = new Date(comment.createdAt);
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
                        <time dateTime={comment.createdAt}>
                            {Number.isNaN(created.valueOf())
                                ? comment.createdAt
                                : date.format(created)}
                        </time>
                    </div>
                    {comment.parent && renderQuote(comment.parent)}
                    <p className={comment.deleted ? styles.deleted : styles.body}>
                        {comment.deleted ? t('site.deleted') : comment.body}
                    </p>
                    {!comment.deleted && (
                        <Group gap="xs" wrap="wrap">
                            {comment.position != null && (
                                <Button
                                    disabled={Boolean(busy) || foreignSong}
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
                                disabled={Boolean(busy)}
                                leftSection={
                                    <Icon
                                        fill={comment.liked ? 'primary' : 'default'}
                                        icon="favorite"
                                        size="sm"
                                    />
                                }
                                onClick={() =>
                                    void act(
                                        `like-${comment.id}`,
                                        () =>
                                            siteApi.request(
                                                `/site/comment/${comment.id}/like`,
                                                { liked: !comment.liked },
                                                'PUT',
                                            ),
                                        () => void refresh(),
                                    )
                                }
                                size="compact-sm"
                                variant={comment.liked ? 'light' : 'subtle'}
                            >
                                {comment.likes || t('site.like')}
                            </Button>
                            <Button
                                onClick={() => {
                                    setAnchor(null);
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
                {comment.canDelete && !comment.deleted && (
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
                        </Popover.Dropdown>
                    </Popover>
                )}
            </article>
        );
    };
    const modalHandlers = (close: () => void) => ({ close, open: () => undefined, toggle: close });
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
                    <Textarea
                        aria-label={t('site.writeComment')}
                        autosize
                        error={composerError || (length > limit ? t('discussion.tooLong') : false)}
                        maxRows={7}
                        minRows={2}
                        onChange={(event) => setBody(event.currentTarget.value)}
                        placeholder={t('site.writeComment')}
                        ref={input}
                        value={body}
                    />
                    <div className={styles.composeActions}>
                        <Group gap="xs">
                            {(canAttach || position != null) && (
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
                                {t(reply ? 'site.reply' : 'site.publish')}
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
                <Text fw={600} size="sm">
                    {t('discussion.latest')}
                </Text>
                {!player && Boolean(first?.favoriteCount) && (
                    <Button
                        disabled={!first?.people?.length}
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
            {comments.map((comment) => renderCard(comment))}
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
                    {renderCard(anchor, true)}
                </Modal>
            )}
            {showPeople && (
                <Modal
                    handlers={modalHandlers(() => setShowPeople(false))}
                    opened
                    title={t('site.favoriteCount', { count: first?.favoriteCount })}
                >
                    <Group gap="xs">
                        {first?.people?.map((person) => (
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
                </Modal>
            )}
        </section>
    );
}

function playbackTime(seconds: number) {
    return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
