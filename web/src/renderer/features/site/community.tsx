import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import formatDuration from 'format-duration';
import { Fragment, ReactNode, useDeferredValue, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import { DiscussionPanel } from './discussion-panel';
import { EmojiText, useDiscussionEmoji } from './discussion-emoji';
import { MemberAvatar, MemberCard } from './room-members';
import roomStyles from './room.module.css';
import { siteApi } from './site-api';
import styles from './site.module.css';

import { useItemImageUrl } from '/@/renderer/components/item-image/item-image';
import { LibraryHeaderBar } from '/@/renderer/features/shared/components/library-header-bar';
import { useAuthStore } from '/@/renderer/store/auth.store';
import { Badge } from '/@/shared/components/badge/badge';
import { Button } from '/@/shared/components/button/button';
import { Group } from '/@/shared/components/group/group';
import { AppIconSelection, Icon } from '/@/shared/components/icon/icon';
import { Select } from '/@/shared/components/select/select';
import { Skeleton } from '/@/shared/components/skeleton/skeleton';
import { Stack } from '/@/shared/components/stack/stack';
import { Switch } from '/@/shared/components/switch/switch';
import { Text } from '/@/shared/components/text/text';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { toast } from '/@/shared/components/toast/toast';
import { LibraryItem } from '/@/shared/types/domain-types';

export type CommunityPerson = {
    avatarVersion: number;
    bio: string;
    duration?: number;
    friendship: 'friend' | 'incoming' | 'none' | 'outgoing' | 'self';
    id: string;
    name: string;
    status: 'hidden' | 'offline' | 'online' | 'together';
    track?: string;
};

const activityKinds = [
    'thought',
    'comment',
    'interaction',
    'favorite',
    'rating',
    'milestone',
] as const;

type Event = {
    artist: string;
    at: string;
    avatarVersion: number;
    body: string;
    commentId: null | number;
    coverId: string;
    itemId: string;
    itemType: 'album' | 'artist' | 'song' | 'thought';
    key: string;
    kind: Exclude<(typeof activityKinds)[number], 'interaction'> | 'like' | 'reply';
    name: string;
    title: string;
    userId: string;
    value: number;
};

type DirectoryPage = { next: null | number; users: CommunityPerson[] };
type TimelineCursor = { before: number; key: string };
type TimelinePage = { events: Event[]; next: TimelineCursor | null };
type HistoryPage = {
    canView: boolean;
    entries: { artist: string; at: string; id: number; songId: string; title: string }[];
    next: null | number;
};

function groupTimelineEvents(events: Event[], day: Intl.DateTimeFormat) {
    const groups: { comments: boolean; entries: { date: string; event: Event }[] }[] = [];
    for (const event of events) {
        const date = day.format(new Date(event.at));
        const comments =
            event.itemType !== 'thought' && (event.kind === 'comment' || event.kind === 'reply');
        const last = groups.at(-1);
        const previous = last?.entries[0].event;
        if (
            comments &&
            last?.comments &&
            previous?.itemType === event.itemType &&
            previous.itemId === event.itemId
        ) {
            last.entries.push({ date, event });
        } else {
            groups.push({ comments, entries: [{ date, event }] });
        }
    }
    return groups;
}

function discussionPath(event: Event) {
    return `/community/discussion/${event.itemType}/${encodeURIComponent(event.itemId)}`;
}

function TimelineMedia({ event }: { event: Event }) {
    const image = useItemImageUrl({
        id: event.coverId || undefined,
        itemType:
            event.itemType === 'artist'
                ? LibraryItem.ARTIST
                : event.itemType === 'album'
                  ? LibraryItem.ALBUM
                  : LibraryItem.SONG,
        size: 96,
    });
    return (
        <Link className={styles.mediaLink} to={musicPath(event.itemType, event.itemId)}>
            {image ? (
                <img alt="" className={styles.timelineCover} loading="lazy" src={image} />
            ) : (
                <Icon icon={event.itemType === 'artist' ? 'artist' : 'album'} size="sm" />
            )}
            <span>
                {event.title}
                {event.artist && <small>{event.artist}</small>}
            </span>
        </Link>
    );
}

export function musicPath(kind: string, id: string) {
    const key = encodeURIComponent(id);
    if (kind === 'album') return `/library/albums/${key}`;
    if (kind === 'artist') return `/library/artists/${key}`;
    return `/track/${key}`;
}

export function useCommunityScope() {
    const server = useAuthStore((state) => state.currentServer);
    return `${server?.id ?? ''}:${server?.userId ?? ''}`;
}

export function SiteHeading({
    children,
    icon,
    title,
}: {
    children?: ReactNode;
    icon: 'discussion' | 'download' | 'users';
    title: string;
}) {
    return (
        <Group justify="space-between">
            <div className={styles.minWidth}>
                <LibraryHeaderBar ignoreMaxWidth>
                    <LibraryHeaderBar.Title>
                        <span className={roomStyles.queuePanelTitle}>
                            <Icon icon={icon} size="lg" />
                            {title}
                        </span>
                    </LibraryHeaderBar.Title>
                </LibraryHeaderBar>
            </div>
            {children}
        </Group>
    );
}

export function CommunityHeading({
    icon,
    order = 2,
    title,
}: {
    icon: AppIconSelection;
    order?: 2 | 3;
    title: string;
}) {
    return (
        <Text
            className={styles.sectionTitle}
            component={order === 2 ? 'h2' : 'h3'}
            fw={700}
            size={order === 2 ? 'lg' : 'sm'}
        >
            <Icon icon={icon} size="sm" />
            {title}
        </Text>
    );
}

export function CommunityLoad({
    error,
    pending,
    retry,
}: {
    error: boolean;
    pending: boolean;
    retry: () => void;
}) {
    const { t } = useTranslation();
    if (pending) return <Skeleton aria-label={t('discussion.loading')} height={72} />;
    if (!error) return null;
    return (
        <Group gap="xs">
            <Text c="dimmed" role="alert" size="sm">
                {t('site.community.loadFailed')}
            </Text>
            <Button onClick={retry} size="compact-sm" variant="light">
                {t('discussion.retry')}
            </Button>
        </Group>
    );
}

export function FriendActions({ person }: { person: CommunityPerson }) {
    const { t } = useTranslation();
    const client = useQueryClient();
    const change = useMutation({
        mutationFn: (method: 'DELETE' | 'PUT') =>
            siteApi.request(`/site/friends/${encodeURIComponent(person.id)}`, undefined, method),
        onError: (error) => toast.error({ message: error.message }),
        onSuccess: () => client.invalidateQueries({ queryKey: ['site'] }),
    });
    if (person.friendship === 'self') return null;
    const incoming = person.friendship === 'incoming';
    const remove = person.friendship === 'friend' || person.friendship === 'outgoing';
    const label = incoming
        ? 'acceptFriend'
        : person.friendship === 'friend'
          ? 'removeFriend'
          : remove
            ? 'cancelFriend'
            : 'addFriend';
    return (
        <Group gap={4} justify="center">
            <Button
                loading={change.isPending}
                onClick={() => change.mutate(remove ? 'DELETE' : 'PUT')}
                size="compact-xs"
                variant={remove ? 'subtle' : 'light'}
            >
                {t(`site.community.${label}`)}
            </Button>
            {incoming && (
                <Button
                    disabled={change.isPending}
                    onClick={() => change.mutate('DELETE')}
                    size="compact-xs"
                    variant="subtle"
                >
                    {t('site.community.declineFriend')}
                </Button>
            )}
        </Group>
    );
}

export function CommunityDirectory() {
    const { t } = useTranslation();
    const [term, setTerm] = useState('');
    const search = useDeferredValue(term.trim());
    return (
        <section className={styles.surface}>
            <Stack gap="md">
                <CommunityHeading icon="users" title={t('site.community.people')} />
                <TextInput
                    aria-label={t('site.community.searchUsers')}
                    leftSection={<Icon icon="search" size="xs" />}
                    maxLength={80}
                    onChange={(event) => setTerm(event.currentTarget.value)}
                    placeholder={t('site.community.searchUsers')}
                    value={term}
                />
                <DirectoryGroup group="requests" icon="bell" search={search} />
                <DirectoryGroup group="friends" icon="favorite" search={search} />
                <DirectoryGroup group="others" icon="users" search={search} />
            </Stack>
        </section>
    );
}

function DirectoryGroup({
    group,
    icon,
    search,
}: {
    group: 'friends' | 'others' | 'requests';
    icon: AppIconSelection;
    search: string;
}) {
    const { t } = useTranslation();
    const scope = useCommunityScope();
    const directory = useInfiniteQuery({
        getNextPageParam: (last: DirectoryPage) => last.next ?? undefined,
        initialPageParam: 0,
        queryFn: ({ pageParam }) =>
            siteApi.request<DirectoryPage>(
                `/site/users?q=${encodeURIComponent(search)}&group=${group}&offset=${pageParam}`,
            ),
        queryKey: ['site', 'users', scope, search, group],
        refetchInterval: 10_000,
    });
    const users = [
        ...new Map(
            directory.data?.pages.flatMap(({ users }) =>
                users.map((person) => [person.id, person] as const),
            ),
        ).values(),
    ];
    return (
        <Stack className={styles.directoryGroup} gap="sm">
            <CommunityHeading icon={icon} order={3} title={t(`site.community.directory.${group}`)} />
            <CommunityLoad
                error={directory.isError}
                pending={directory.isPending}
                retry={() => void directory.refetch()}
            />
            {directory.isSuccess && users.length === 0 && (
                <Text c="dimmed" size="sm">
                    {t('site.community.noUsers')}
                </Text>
            )}
            {users.length > 0 && (
                <ul className={roomStyles.memberList}>
                    {users.map((person) => (
                        <MemberCard
                            id={person.id}
                            key={person.id}
                            name={person.name}
                            status={person.status}
                            statusLabel={t(`site.community.status.${person.status}`)}
                            version={person.avatarVersion}
                        >
                            {person.track && (
                                <Text
                                    className={roomStyles.memberName}
                                    size="xs"
                                    title={person.track}
                                    truncate
                                >
                                    {person.track}
                                </Text>
                            )}
                            {person.duration !== undefined && (
                                <time>{formatDuration(person.duration * 1000)}</time>
                            )}
                            {person.friendship === 'self' || person.friendship === 'friend' ? (
                                <Badge size="xs" variant="light">
                                    {t(`site.community.${person.friendship}`)}
                                </Badge>
                            ) : (
                                <FriendActions person={person} />
                            )}
                        </MemberCard>
                    ))}
                </ul>
            )}
            {directory.hasNextPage && (
                <Button
                    loading={directory.isFetchingNextPage}
                    onClick={() => void directory.fetchNextPage()}
                    variant="light"
                >
                    {t('site.more')}
                </Button>
            )}
        </Stack>
    );
}

export function CommunityTimeline({ userId }: { userId?: string }) {
    const { i18n, t } = useTranslation();
    const scope = useCommunityScope();
    const emoji = useDiscussionEmoji();
    const [kind, setKind] = useState('all');
    const [friends, setFriends] = useState(false);
    const timeline = useInfiniteQuery({
        getNextPageParam: (last: TimelinePage) => last.next ?? undefined,
        initialPageParam: null as TimelineCursor | null,
        queryFn: ({ pageParam }) => {
            const params = new URLSearchParams({
                before: String(pageParam?.before ?? 0),
                friends: String(Number(friends)),
                key: pageParam?.key ?? '',
                kind: kind === 'all' ? '' : kind,
                user: userId ?? '',
            });
            return siteApi.request<TimelinePage>(`/site/timeline?${params}`);
        },
        queryKey: ['site', 'timeline', scope, userId, kind, friends],
        refetchInterval: 30_000,
    });
    const events = timeline.data?.pages.flatMap((page) => page.events) ?? [];
    const day = new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: 'full' });
    const time = new Intl.DateTimeFormat(i18n.resolvedLanguage, { timeStyle: 'short' });
    const groups = groupTimelineEvents(events, day);
    const renderDate = (date: string) => (
        <Text className={styles.timelineDate} component="h3" fw={600} size="sm">
            {date}
        </Text>
    );
    const renderEvent = (event: Event, grouped: boolean) => (
        <article className={styles.timelineEntry} key={event.key}>
            <Link
                aria-label={event.name}
                to={`/community/profile/${encodeURIComponent(event.userId)}`}
            >
                <MemberAvatar id={event.userId} name={event.name} version={event.avatarVersion} />
            </Link>
            <Stack className={styles.minWidth} gap={6}>
                <Group gap="xs" justify="space-between">
                    <Text className={styles.wrapText} size="sm">
                        <Link to={`/community/profile/${encodeURIComponent(event.userId)}`}>
                            {event.name}
                        </Link>
                        {' · '}
                        {t(`site.community.event.${event.kind}`, {
                            count: event.value,
                            rating: event.value,
                        })}
                    </Text>
                    <Text c="dimmed" component="time" dateTime={event.at} size="xs">
                        {time.format(new Date(event.at))}
                    </Text>
                </Group>
                {event.body && (
                    <div className={styles.timelineBody}>
                        <EmojiText index={emoji.data?.index} text={event.body} />
                    </div>
                )}
                {!grouped && event.title && <TimelineMedia event={event} />}
                {!grouped && event.commentId && (
                    <Button
                        component={Link}
                        justify="flex-start"
                        size="compact-xs"
                        to={`${discussionPath(event)}/${event.commentId}`}
                        variant="subtle"
                    >
                        {t('site.community.openDiscussion')}
                    </Button>
                )}
            </Stack>
        </article>
    );
    return (
        <section className={styles.surface}>
            <Stack gap="md">
                {!userId && <DiscussionPanel composerOnly id="global" kind="thought" />}
                <Group align="center" justify="space-between">
                    <CommunityHeading
                        icon="list"
                        title={t(userId ? 'site.community.userTimeline' : 'site.community.timeline')}
                    />
                    <Button
                        leftSection={<Icon icon="refresh" size="xs" />}
                        loading={timeline.isFetching && !timeline.isFetchingNextPage}
                        onClick={() => void timeline.refetch()}
                        size="compact-sm"
                        variant="subtle"
                    >
                        {t('site.community.refresh')}
                    </Button>
                </Group>
                <Group align="center" gap="sm">
                    <Select
                        aria-label={t('site.community.activityType')}
                        className={styles.activityFilter}
                        data={['all', ...activityKinds].map((value) => ({
                            label: t(`site.community.filter.${value}`),
                            value,
                        }))}
                        onChange={(value) => setKind(value ?? 'all')}
                        value={kind}
                    />
                    {!userId && (
                        <Switch
                            checked={friends}
                            label={t('site.community.friendsOnly')}
                            onChange={(event) => setFriends(event.currentTarget.checked)}
                        />
                    )}
                </Group>
                <CommunityLoad
                    error={timeline.isError}
                    pending={timeline.isPending}
                    retry={() => void timeline.refetch()}
                />
                {timeline.isSuccess && !events.length && (
                    <Text c="dimmed" className={styles.emptyState} size="sm">
                        {t('site.community.noActivity')}
                    </Text>
                )}
                {events.length > 0 && (
                    <ol className={styles.timeline}>
                        {groups.map((group, index) => {
                            const { date, event: first } = group.entries[0];
                            return (
                                <li key={first.key}>
                                    {groups[index - 1]?.entries.at(-1)?.date !== date && renderDate(date)}
                                    {group.comments ? (
                                        <Stack className={styles.timelineCommentGroup} gap="xs">
                                            <Group gap="xs" justify="space-between">
                                                <Text component="h4" fw={600} size="sm">
                                                    {t(`site.community.commentsOn.${first.itemType}`)}
                                                </Text>
                                                <Button
                                                    component={Link}
                                                    leftSection={
                                                        <Icon icon="discussion" size="xs" />
                                                    }
                                                    size="compact-xs"
                                                    to={discussionPath(first)}
                                                    variant="subtle"
                                                >
                                                    {t('site.community.openCommentSection')}
                                                </Button>
                                            </Group>
                                            {first.title && <TimelineMedia event={first} />}
                                            <div className={styles.timelineComments}>
                                                {group.entries.map((entry, entryIndex) => (
                                                    <Fragment key={entry.event.key}>
                                                        {entryIndex > 0 &&
                                                            group.entries[entryIndex - 1].date !== entry.date &&
                                                            renderDate(entry.date)}
                                                        {renderEvent(entry.event, true)}
                                                    </Fragment>
                                                ))}
                                            </div>
                                        </Stack>
                                    ) : (
                                        renderEvent(first, false)
                                    )}
                                </li>
                            );
                        })}
                    </ol>
                )}
                {timeline.hasNextPage && (
                    <Button
                        leftSection={<Icon icon="dropdown" size="xs" />}
                        loading={timeline.isFetchingNextPage}
                        onClick={() => void timeline.fetchNextPage()}
                        variant="light"
                    >
                        {t('site.community.moreActivity')}
                    </Button>
                )}
            </Stack>
        </section>
    );
}

export function CommunityHistory({ userId }: { userId: string }) {
    const { i18n, t } = useTranslation();
    const scope = useCommunityScope();
    const date = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
        dateStyle: 'medium',
        timeStyle: 'short',
    });
    const history = useInfiniteQuery({
        getNextPageParam: (last: HistoryPage) => last.next ?? undefined,
        initialPageParam: 0,
        queryFn: ({ pageParam }) =>
            siteApi.request<HistoryPage>(
                `/site/profile/${encodeURIComponent(userId)}/history?offset=${pageParam}`,
            ),
        queryKey: ['site', 'history', scope, userId],
    });
    const first = history.data?.pages[0];
    const entries = first?.canView
        ? (history.data?.pages.flatMap((page) => page.entries) ?? [])
        : [];
    return (
        <section className={styles.surface}>
            <Stack gap="sm">
                <CommunityHeading icon="lastPlayed" title={t('site.community.history')} />
                <CommunityLoad
                    error={history.isError}
                    pending={history.isPending}
                    retry={() => void history.refetch()}
                />
                {first && !entries.length && (
                    <Text c="dimmed" className={styles.emptyState} size="sm">
                        {t(
                            first.canView
                                ? 'site.community.noHistory'
                                : 'site.community.privateHistory',
                        )}
                    </Text>
                )}
                {entries.length > 0 && (
                    <ol className={styles.historyList}>
                        {entries.map((entry) => (
                            <li key={entry.id}>
                                <Link
                                    className={styles.wrapText}
                                    to={musicPath('song', entry.songId)}
                                >
                                    {entry.title}
                                </Link>
                                <Text c="dimmed" className={styles.wrapText} size="xs">
                                    {entry.artist}
                                </Text>
                                <Text c="dimmed" component="time" dateTime={entry.at} size="xs">
                                    {date.format(new Date(entry.at))}
                                </Text>
                            </li>
                        ))}
                    </ol>
                )}
                {first?.canView && history.hasNextPage && (
                    <Button
                        loading={history.isFetchingNextPage}
                        onClick={() => void history.fetchNextPage()}
                        variant="light"
                    >
                        {t('site.more')}
                    </Button>
                )}
            </Stack>
        </section>
    );
}

export function CommunityDiscussionPage() {
    const { t } = useTranslation();
    const { comment, id, kind } = useParams();
    const commentId = comment === undefined ? undefined : Number(comment);
    if (
        !id ||
        (kind !== 'thought' && kind !== 'album' && kind !== 'artist' && kind !== 'song') ||
        (kind === 'thought' && commentId === undefined) ||
        (commentId !== undefined && (!Number.isSafeInteger(commentId) || commentId < 1))
    )
        return null;
    return (
        <div className={styles.page}>
            <Stack gap="md">
                <Group gap="xs">
                    <Button component={Link} to="/account" variant="light">
                        {t('site.account')}
                    </Button>
                    {kind !== 'thought' && (
                        <Button component={Link} to={musicPath(kind, id)} variant="subtle">
                            {t('site.community.openMedia')}
                        </Button>
                    )}
                </Group>
                <DiscussionPanel commentId={commentId} id={id} kind={kind} />
            </Stack>
        </div>
    );
}
