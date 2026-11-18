import { useQuery } from '@tanstack/react-query';
import { Fragment, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './discussion-emoji.module.css';

import { Icon } from '/@/shared/components/icon/icon';
import { Popover } from '/@/shared/components/popover/popover';
import { Tabs } from '/@/shared/components/tabs/tabs';

type EmojiGroup = { id: string; items: EmojiItem[]; label: string };
type EmojiIndex = ReadonlyMap<string, EmojiItem>;
type EmojiItem = { alt: string; id: string; src: string };

export function EmojiPicker({
    disabled,
    emoji,
    onSelect,
}: {
    disabled: boolean;
    emoji: ReturnType<typeof useDiscussionEmoji>;
    onSelect: (token: string) => void;
}) {
    const { t } = useTranslation();
    const [opened, setOpened] = useState<'hover' | 'press' | null>(null);
    const [activeGroup, setActiveGroup] = useState<string>();
    const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
    const touch = useRef<{ x: number; y: number }>(undefined);
    const groups = emoji.data?.groups;
    const groupId = activeGroup ?? groups?.[0]?.id;
    const groupIndex = groups?.findIndex((group) => group.id === groupId) ?? -1;
    const close = () => setOpened(null);
    const cancelClose = () => clearTimeout(timer.current);
    const delayedClose = () => {
        cancelClose();
        timer.current = setTimeout(close, 120);
    };

    useEffect(() => () => clearTimeout(timer.current), []);

    return (
        <Popover
            disabled={disabled}
            onDismiss={close}
            opened={Boolean(opened) && !disabled}
            position="bottom-end"
            returnFocus={opened === 'press'}
            trapFocus={opened === 'press'}
            width="min(34rem, calc(100vw - 2rem))"
        >
            <Popover.Target>
                <button
                    className={styles.trigger}
                    disabled={disabled}
                    onClick={() => {
                        cancelClose();
                        setOpened((value) => (value === 'press' ? null : 'press'));
                    }}
                    onPointerEnter={(event) => {
                        if (event.pointerType !== 'mouse') return;
                        cancelClose();
                        if (!disabled) setOpened((value) => value ?? 'hover');
                    }}
                    onPointerLeave={(event) => {
                        if (event.pointerType === 'mouse') delayedClose();
                    }}
                    type="button"
                >
                    {t('discussion.emoji')}
                </button>
            </Popover.Target>
            <Popover.Dropdown
                className={styles.panel}
                onFocus={cancelClose}
                onPointerEnter={cancelClose}
                onPointerLeave={(event) => {
                    if (event.pointerType === 'mouse') delayedClose();
                }}
            >
                {groups && groupId ? (
                    <Tabs
                        classNames={{ list: styles.tabs, panel: styles.grid, tab: styles.tab }}
                        keepMounted={false}
                        onChange={(value) => value && setActiveGroup(value)}
                        unstyled
                        value={groupId}
                    >
                        <Tabs.List aria-label={t('discussion.emojiGroups')}>
                            {groups.map((group) => (
                                <Tabs.Tab
                                    key={group.id}
                                    ref={(element) => {
                                        if (element && group.id === groupId) {
                                            element.scrollIntoView({
                                                block: 'nearest',
                                                inline: 'nearest',
                                            });
                                        }
                                    }}
                                    value={group.id}
                                >
                                    {group.label}
                                </Tabs.Tab>
                            ))}
                        </Tabs.List>
                        <div
                            className={styles.contents}
                            key={groupId}
                            onTouchCancel={() => {
                                touch.current = undefined;
                            }}
                            onTouchEnd={(event) => {
                                const start = touch.current;
                                const end = event.changedTouches[0];
                                touch.current = undefined;
                                if (!start || !end) return;
                                const horizontal = start.x - end.clientX;
                                if (
                                    Math.abs(horizontal) < 40 ||
                                    Math.abs(horizontal) <= Math.abs(start.y - end.clientY)
                                )
                                    return;
                                const next = groups[groupIndex + Math.sign(horizontal)];
                                if (next) setActiveGroup(next.id);
                            }}
                            onTouchStart={(event) => {
                                const start = event.touches[0];
                                touch.current = start && { x: start.clientX, y: start.clientY };
                            }}
                        >
                            {groups.map((group) => (
                                <Tabs.Panel key={group.id} value={group.id}>
                                    {group.id === groupId &&
                                        group.items.map((item) => (
                                            <button
                                                aria-label={item.alt}
                                                className={styles.item}
                                                key={item.id}
                                                onClick={() => {
                                                    close();
                                                    onSelect(`(${item.id})`);
                                                }}
                                                title={item.alt}
                                                type="button"
                                            >
                                                <EmojiImage item={item} />
                                            </button>
                                        ))}
                                </Tabs.Panel>
                            ))}
                        </div>
                        <div aria-hidden="true" className={styles.swipeHint}>
                            <span hidden={groupIndex <= 0}>
                                <Icon icon="arrowLeftS" size="sm" />
                            </span>
                            <span hidden={groupIndex >= groups.length - 1}>
                                <Icon icon="arrowRightS" size="sm" />
                            </span>
                        </div>
                    </Tabs>
                ) : (
                    <p className={styles.status} role="status">
                        {t(
                            emoji.isError
                                ? 'discussion.emojiUnavailable'
                                : 'discussion.emojiLoading',
                        )}
                        {emoji.isError && (
                            <button
                                className={styles.trigger}
                                onClick={() => void emoji.refetch()}
                                type="button"
                            >
                                {t('discussion.retry')}
                            </button>
                        )}
                    </p>
                )}
            </Popover.Dropdown>
        </Popover>
    );
}

export function EmojiText({ index, text }: { index?: EmojiIndex; text: string }) {
    if (!index) return text;
    return text.split(/(\([^()\s]+_[^()\s]+\))/gu).map((part, offset) => {
        const item = offset % 2 ? index.get(part.slice(1, -1)) : undefined;
        return <Fragment key={offset}>{item ? <EmojiImage item={item} /> : part}</Fragment>;
    });
}

export function useDiscussionEmoji() {
    return useQuery({
        queryFn: async () => {
            const response = await fetch(new URL('emoji/manifest.json', document.baseURI));
            if (!response.ok) throw new Error(response.statusText);
            const { groups } = (await response.json()) as { groups: EmojiGroup[] };
            const index = new Map(
                groups.flatMap((group) => group.items.map((item) => [item.id, item] as const)),
            );
            return { groups, index };
        },
        queryKey: ['site', 'discussion-emoji'],
        staleTime: Infinity,
    });
}

function EmojiImage({ item }: { item: EmojiItem }) {
    return (
        <img
            alt={item.alt}
            className={styles.image}
            decoding="async"
            draggable={false}
            loading="lazy"
            src={new URL(item.src.slice(1), document.baseURI).href}
            title={item.alt}
        />
    );
}
