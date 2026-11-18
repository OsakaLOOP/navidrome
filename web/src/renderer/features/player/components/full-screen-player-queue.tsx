import clsx from 'clsx';
import { AnimatePresence, motion, Variants } from 'motion/react';
import { lazy, Suspense, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './full-screen-player-queue.module.css';

import { Lyrics } from '/@/renderer/features/lyrics/lyrics';
import { PlayQueue } from '/@/renderer/features/now-playing/components/play-queue';
import { FullScreenSimilarSongs } from '/@/renderer/features/player/components/full-screen-similar-songs';
import { useIsRadioActive } from '/@/renderer/features/radio/hooks/use-radio-player';
import { DiscussionPanel, useDiscussionCount } from '/@/renderer/features/site/discussion-panel';
import { RoomQueue, useRoomActive } from '/@/renderer/features/site/room';
import { useListSettings, usePlaybackSettings, useSettingsStore } from '/@/renderer/store';
import {
    useFullScreenPlayerStore,
    useFullScreenPlayerStoreActions,
} from '/@/renderer/store/full-screen-player.store';
import { usePlayerSong } from '/@/renderer/store/player.store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Group } from '/@/shared/components/group/group';
import { AppIcon } from '/@/shared/components/icon/icon';
import { Text } from '/@/shared/components/text/text';
import { ItemListKey } from '/@/shared/types/types';

const AudioMotionAnalyzerVisualizer = lazy(() =>
    import('../../visualizer/components/audiomotionanalyzer/visualizer').then((module) => ({
        default: module.Visualizer,
    })),
);

const ButterchurnVisualizer = lazy(() =>
    import('../../visualizer/components/butternchurn/visualizer').then((module) => ({
        default: module.Visualizer,
    })),
);

const isDesktopPanelOpen = (activeTab: string, webAudio: boolean) =>
    activeTab === 'queue' ||
    activeTab === 'related' ||
    activeTab === 'lyrics' ||
    activeTab === 'discussion' ||
    (activeTab === 'visualizer' && webAudio);

const moduleContentVariants: Variants = {
    animate: {
        opacity: 1,
        transition: {
            duration: 0.4,
            ease: 'easeOut',
        },
        x: 0,
    },
    exit: {
        opacity: 0,
        transition: {
            duration: 0.4,
            ease: 'easeOut',
        },
        x: '10%',
    },
    initial: {
        opacity: 0,
        x: '10%',
    },
};

interface ControlItem {
    active: boolean;
    count?: number;
    icon: keyof typeof AppIcon;
    label: string;
    onClick: () => void;
}

const Controls = () => {
    const { t } = useTranslation();
    const song = usePlayerSong();
    const radio = useIsRadioActive();
    const count = useDiscussionCount(radio ? undefined : song?.id);
    const { activeTab } = useFullScreenPlayerStore();
    const { setStore } = useFullScreenPlayerStoreActions();
    const { webAudio } = usePlaybackSettings();

    const toggleTab = (tab: string) => {
        setStore({ activeTab: activeTab === tab ? '' : tab });
    };

    const headerItems = useMemo(() => {
        const items: ControlItem[] = [
            {
                active: activeTab === 'queue',
                icon: 'queue',
                label: t('page.fullscreenPlayer.upNext'),
                onClick: () => toggleTab('queue'),
            },
            {
                active: activeTab === 'related',
                icon: 'related',
                label: t('page.fullscreenPlayer.related'),
                onClick: () => toggleTab('related'),
            },
            {
                active: activeTab === 'lyrics',
                icon: 'microphone',
                label: t('page.fullscreenPlayer.lyrics'),
                onClick: () => toggleTab('lyrics'),
            },
        ];

        if (webAudio) {
            items.push({
                active: activeTab === 'visualizer',
                icon: 'audioLines',
                label: t('page.fullscreenPlayer.visualizer'),
                onClick: () => toggleTab('visualizer'),
            });
        }

        if (window.SERVER_NAME === 'ndFork' && song?.id && !radio)
            items.push({
                active: activeTab === 'discussion',
                count,
                icon: 'discussion',
                label: t('site.discussion'),
                onClick: () => toggleTab('discussion'),
            });

        return items;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeTab, count, radio, setStore, song?.id, t, webAudio]);

    return (
        <Group
            className={clsx(styles.controlsContainer, 'full-screen-player-controls-container')}
            gap="xs"
            p="0.5rem"
            pos="absolute"
        >
            {headerItems.map((item) => (
                <div key={`tab-${item.label}`}>
                    <ActionIcon
                        aria-label={
                            item.count === undefined ? item.label : `${item.label} (${item.count})`
                        }
                        icon={item.icon}
                        iconProps={{
                            color: item.active ? 'primary' : undefined,
                            size: 'lg',
                        }}
                        onClick={item.onClick}
                        tooltip={{ label: item.label }}
                        variant="subtle"
                    ></ActionIcon>
                    {!!item.count && (
                        <Text aria-hidden="true" size="xs" ta="center">
                            {item.count > 99 ? '99+' : item.count}
                        </Text>
                    )}
                </div>
            ))}
        </Group>
    );
};

export const FullScreenPlayerControls = Controls;

export const FullScreenPlayerQueue = () => {
    const shared = useRoomActive();
    const radio = useIsRadioActive();
    const song = usePlayerSong();
    const { activeTab } = useFullScreenPlayerStore();
    const { webAudio } = usePlaybackSettings();
    const visualizerType = useSettingsStore((store) => store.visualizer.type);
    const { table } = useListSettings(ItemListKey.FULL_SCREEN) || {};
    const queueContainerClassName = clsx(styles.queueContainer, {
        [styles.queueContainerFadeTopBottom]: !table?.enableHeader,
    });
    const isPanelOpen = isDesktopPanelOpen(activeTab, webAudio);
    const isCollapsed = !isPanelOpen;

    return (
        <div
            className={clsx(styles.gridContainer, 'full-screen-player-queue-container', {
                [styles.gridContainerCollapsed]: isCollapsed,
            })}
        >
            <AnimatePresence initial={false} mode="wait">
                {activeTab === 'queue' ? (
                    <motion.div
                        animate="animate"
                        className={queueContainerClassName}
                        exit="exit"
                        initial="initial"
                        key="queue"
                        variants={moduleContentVariants}
                    >
                        {shared ? (
                            <RoomQueue />
                        ) : (
                            <PlayQueue
                                enableScrollShadow={false}
                                listKey={ItemListKey.FULL_SCREEN}
                                searchTerm={undefined}
                            />
                        )}
                    </motion.div>
                ) : activeTab === 'related' ? (
                    <motion.div
                        animate="animate"
                        className={queueContainerClassName}
                        exit="exit"
                        initial="initial"
                        key="related"
                        variants={moduleContentVariants}
                    >
                        <FullScreenSimilarSongs />
                    </motion.div>
                ) : activeTab === 'lyrics' ? (
                    <motion.div
                        animate="animate"
                        className={styles.moduleContent}
                        exit="exit"
                        initial="initial"
                        key="lyrics"
                        variants={moduleContentVariants}
                    >
                        <Lyrics fadeOutNoLyricsMessage={false} />
                    </motion.div>
                ) : activeTab === 'discussion' && song && !radio ? (
                    <div
                        className={styles.moduleContent}
                        key={song.id}
                        style={{ overflow: 'auto' }}
                    >
                        <DiscussionPanel id={song.id} kind="song" player />
                    </div>
                ) : activeTab === 'visualizer' && webAudio ? (
                    <motion.div
                        animate="animate"
                        className={styles.moduleContent}
                        exit="exit"
                        initial="initial"
                        key="visualizer"
                        variants={moduleContentVariants}
                    >
                        <Suspense fallback={<></>}>
                            {visualizerType === 'butterchurn' ? (
                                <ButterchurnVisualizer />
                            ) : (
                                <AudioMotionAnalyzerVisualizer />
                            )}
                        </Suspense>
                    </motion.div>
                ) : null}
            </AnimatePresence>
        </div>
    );
};
