import formatDuration from 'format-duration';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { ReactNode } from 'react';

import styles from './room.module.css';

import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';
import { useAuthStore } from '/@/renderer/store/auth.store';

export function MemberAvatar({
    className,
    id,
    name,
    version,
}: {
    className?: string;
    id?: string;
    name: string;
    version?: number;
}) {
    const serverUrl = useAuthStore((state) => state.currentServer?.url);
    return (
        <span aria-hidden="true" className={`${styles.memberAvatar} ${className ?? ''}`}>
            {id && version ? (
                <img
                    alt=""
                    loading="lazy"
                    src={`${serverUrl || window.SERVER_URL}/site/profile/${encodeURIComponent(id)}/avatar?v=${version}`}
                />
            ) : (
                Array.from(name)[0]?.toLocaleUpperCase() || <Icon icon="user" />
            )}
        </span>
    );
}

export function MemberCard({
    children,
    id,
    name,
    status,
    statusLabel,
    version,
}: {
    children?: ReactNode;
    id: string;
    name: string;
    status: string;
    statusLabel: string;
    version?: number;
}) {
    return (
        <li className={styles.memberCard}>
            <Link className={styles.memberLink} to={`/community/profile/${encodeURIComponent(id)}`}>
                <MemberAvatar id={id} name={name} version={version} />
                <Text className={styles.memberName} size="xs" title={name} truncate>
                    {name}
                </Text>
            </Link>
            <span className={styles.memberState} title={statusLabel}>
                <span aria-hidden="true" className={styles.memberStatus} data-status={status} />
                {statusLabel}
            </span>
            {children}
        </li>
    );
}

export type RoomMember = {
    avatarVersion?: number;
    devices: number;
    id: string;
    joinedAt: number;
    name: string;
    online: boolean;
};

export function RoomMembers({
    memberCount,
    members,
    onlineCount,
    serverTime,
}: {
    memberCount: number;
    members: Record<string, RoomMember>;
    onlineCount: number;
    serverTime: number;
}) {
    const { t } = useTranslation();
    const peers = Object.values(members).sort(
        (first, second) => first.joinedAt - second.joinedAt || first.id.localeCompare(second.id),
    );
    return (
        <Stack className={styles.members} gap="xs">
            <Group gap="xs">
                <Icon icon="users" size="sm" />
                <Text fw={600} size="sm">
                    {t('together.members')}
                </Text>
                <Text c="dimmed" size="xs">
                    {t('together.onlineRatio', { members: memberCount, online: onlineCount })}
                </Text>
            </Group>
            {peers.length > 0 ? (
                <ul aria-label={t('together.members')} className={styles.memberList}>
                    {peers.map((peer) => {
                        const duration = formatDuration(Math.max(0, serverTime - peer.joinedAt));
                        const status = t(
                            peer.online ? 'together.memberOnline' : 'together.memberOffline',
                        );
                        return (
                            <MemberCard
                                id={peer.id}
                                key={peer.id}
                                name={peer.name}
                                status={peer.online ? 'online' : 'offline'}
                                statusLabel={status}
                                version={peer.avatarVersion}
                            >
                                <time aria-label={t('together.memberDuration', { duration })}>
                                    {duration}
                                </time>
                            </MemberCard>
                        );
                    })}
                </ul>
            ) : (
                <Text c="dimmed" size="xs">
                    {t(memberCount ? 'site.community.roomMembersHidden' : 'together.noMembers')}
                </Text>
            )}
        </Stack>
    );
}
