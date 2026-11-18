import { memo, MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './mobile-fullscreen-player.module.css';

import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { RoomPlayerButton, useRoomActive } from '/@/renderer/features/site/room';
import { usePlayerRepeat, usePlayerShuffle } from '/@/renderer/store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Group } from '/@/shared/components/group/group';
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

        return (
            <div className={styles.bottomControlsBar}>
                <Group className={styles.bottomControlsGroup} gap={0}>
                    {shared ? (
                        <RoomPlayerButton />
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
                        <ActionIcon
                            aria-label={t('site.discussion')}
                            className={styles.bottomControlIcon}
                            icon="discussion"
                            iconProps={{ size: 'xl' }}
                            onClick={onToggleDiscussion}
                            tooltip={{ label: t('site.discussion') }}
                            variant="transparent"
                        />
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
