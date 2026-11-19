import { memo, MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './mobile-fullscreen-player.module.css';

import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { useDiscussionCount } from '/@/renderer/features/site/discussion-panel';
import { RoomPlayerButton, useRoomActive } from '/@/renderer/features/site/room';
import { usePlayerRepeat, usePlayerShuffle, usePlayerSong } from '/@/renderer/store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Group } from '/@/shared/components/group/group';
import { Text } from '/@/shared/components/text/text';
import { PlayerRepeat, PlayerShuffle } from '/@/shared/types/types';

interface MobileFullscreenPlayerBottomControlsProps {
    isLyricsActive: boolean;
    isQueueActive: boolean;
    onToggleContextMenu: (e: MouseEvent<HTMLButtonElement | HTMLDivElement>) => void;
    onToggleDiscussion?: () => void;
    onToggleLyrics: () => void;
    onToggleQueue: () => void;
}

export const MobileFullscreenPlayerBottomControls = memo(
    ({
        isLyricsActive,
        isQueueActive,
        onToggleContextMenu,
        onToggleDiscussion,
        onToggleLyrics,
        onToggleQueue,
    }: MobileFullscreenPlayerBottomControlsProps) => {
        const repeat = usePlayerRepeat();
        const shuffle = usePlayerShuffle();
        const { toggleRepeat, toggleShuffle } = usePlayer();
        const { t } = useTranslation();
        const shared = useRoomActive();
        const song = usePlayerSong();
        const count = useDiscussionCount(onToggleDiscussion ? song?.id : undefined);

        return (
            <div className={styles.bottomControlsBar}>
                <Group className={styles.bottomControlsGroup} gap={0}>
                    {shared ? (
                        <RoomPlayerButton position="top" />
                    ) : (
                        <ActionIcon
                            className={styles.bottomControlIcon}
                            icon="mediaShuffle"
                            iconProps={{
                                fill: shuffle === PlayerShuffle.NONE ? 'default' : 'primary',
                                size: 'xl',
                            }}
                            onClick={toggleShuffle}
                            variant="transparent"
                        />
                    )}
                    {!shared && (
                        <ActionIcon
                            className={styles.bottomControlIcon}
                            icon={repeat === PlayerRepeat.ONE ? 'mediaRepeatOne' : 'mediaRepeat'}
                            iconProps={{
                                fill: repeat === PlayerRepeat.NONE ? 'default' : 'primary',
                                size: 'xl',
                            }}
                            onClick={toggleRepeat}
                            variant="transparent"
                        />
                    )}
                    {onToggleDiscussion && (
                        <div>
                            <ActionIcon
                                aria-label={`${t('site.discussion')}${count ? ` (${count})` : ''}`}
                                className={styles.bottomControlIcon}
                                icon="discussion"
                                iconProps={{ size: 'xl' }}
                                onClick={onToggleDiscussion}
                                tooltip={{ label: t('site.discussion') }}
                                variant="transparent"
                            />
                            {!!count && (
                                <Text aria-hidden="true" size="xs" ta="center">
                                    {count > 99 ? '99+' : count}
                                </Text>
                            )}
                        </div>
                    )}
                    <ActionIcon
                        className={styles.bottomControlIcon}
                        icon="queue"
                        iconProps={{
                            fill: isQueueActive ? 'primary' : undefined,
                            size: 'xl',
                        }}
                        onClick={onToggleQueue}
                        variant="transparent"
                    />
                    <ActionIcon
                        className={styles.bottomControlIcon}
                        icon="metadata"
                        iconProps={{
                            fill: isLyricsActive ? 'primary' : undefined,
                            size: 'xl',
                        }}
                        onClick={onToggleLyrics}
                        variant="transparent"
                    />
                    <ActionIcon
                        className={styles.bottomControlIcon}
                        icon="ellipsisVertical"
                        iconProps={{
                            size: 'xl',
                        }}
                        onClick={onToggleContextMenu}
                        variant="transparent"
                    />
                </Group>
            </div>
        );
    },
);

MobileFullscreenPlayerBottomControls.displayName = 'MobileFullscreenPlayerBottomControls';
