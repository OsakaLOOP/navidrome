import { openContextModal, openModal } from '@mantine/modals';
import isElectron from 'is-electron';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { MetadataEditor } from '/@/renderer/features/site/metadata-editor';
import { useAuthStore } from '/@/renderer/store/auth.store';
import { ContextMenu } from '/@/shared/components/context-menu/context-menu';
import { Song } from '/@/shared/types/domain-types';

interface EditMetadataActionProps {
    albumIds?: string[];
    songs?: Song[];
}

const utils = isElectron() ? window.api.utils : null;

export const EditMetadataAction = ({ albumIds, songs: songItems }: EditMetadataActionProps) => {
    const { t } = useTranslation();
    const admin = useAuthStore((s) => s.currentServer?.isAdmin);
    const songs = useMemo(() => songItems?.filter((s) => s.path) ?? [], [songItems]);
    const count = albumIds?.length ?? songs.length;

    const onSelect = useCallback(() => {
        if (window.SERVER_NAME === 'ndFork') {
            const id = albumIds?.[0] || songItems?.[0]?.id;
            if (id)
                openModal({
                    children: <MetadataEditor id={id} kind={albumIds?.length ? 'album' : 'song'} />,
                    size: 'lg',
                    title: t('site.metadata'),
                });
            return;
        }
        openContextModal({
            innerProps: { albumIds, songs },
            modal: 'editMetadata',
            size: 'xl',
            styles: { body: { paddingBottom: 'var(--theme-spacing-xl)' } },
            title: t('page.contextMenu.editMetadata'),
        });
    }, [albumIds, songs, songItems, t]);

    if (window.SERVER_NAME === 'ndFork' ? !admin : !utils) return null;

    return (
        <ContextMenu.Item
            disabled={
                window.SERVER_NAME === 'ndFork'
                    ? (albumIds?.length ?? songItems?.length) !== 1
                    : count === 0
            }
            leftIcon="edit"
            onSelect={onSelect}
        >
            {t('page.contextMenu.editMetadata')}
        </ContextMenu.Item>
    );
};
