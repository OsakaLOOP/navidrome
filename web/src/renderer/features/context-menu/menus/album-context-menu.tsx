import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '/@/renderer/api';
import { AddToPlaylistAction } from '/@/renderer/features/context-menu/actions/add-to-playlist-action';
import { DownloadAction } from '/@/renderer/features/context-menu/actions/download-action';
import { EditMetadataAction } from '/@/renderer/features/context-menu/actions/edit-metadata-action';
import { GetInfoAction } from '/@/renderer/features/context-menu/actions/get-info-action';
import { GoToAction } from '/@/renderer/features/context-menu/actions/go-to-action';
import { PlayAction } from '/@/renderer/features/context-menu/actions/play-action';
import { PlayAlbumRadioAction } from '/@/renderer/features/context-menu/actions/play-album-radio-action';
import { SetFavoriteAction } from '/@/renderer/features/context-menu/actions/set-favorite-action';
import { SetRatingAction } from '/@/renderer/features/context-menu/actions/set-rating-action';
import { ShareAction } from '/@/renderer/features/context-menu/actions/share-action';
import { ContextMenuPreview } from '/@/renderer/features/context-menu/components/context-menu-preview';
import { downloadOffline } from '/@/renderer/features/site/offline';
import { ContextMenu } from '/@/shared/components/context-menu/context-menu';
import { toast } from '/@/shared/components/toast/toast';
import { Album, LibraryItem } from '/@/shared/types/domain-types';

interface AlbumContextMenuProps {
    items: Album[];
    type: LibraryItem.ALBUM;
}

export const AlbumContextMenu = ({ items, type }: AlbumContextMenuProps) => {
    const { t } = useTranslation();
    const { ids } = useMemo(() => {
        const ids = items.map((item) => item.id);
        return { ids };
    }, [items]);

    return (
        <ContextMenu.Content
            bottomStickyContent={<ContextMenuPreview items={items} itemType={type} />}
        >
            <PlayAction ids={ids} itemType={LibraryItem.ALBUM} />
            <PlayAlbumRadioAction album={items[0]} disabled={items.length > 1} />
            <ContextMenu.Divider />
            <AddToPlaylistAction items={ids} itemType={LibraryItem.ALBUM} />
            <ContextMenu.Divider />
            <SetFavoriteAction ids={ids} itemType={LibraryItem.ALBUM} />
            <SetRatingAction ids={ids} itemType={LibraryItem.ALBUM} />
            <ContextMenu.Divider />
            <DownloadAction ids={ids} />
            {window.SERVER_NAME === 'ndFork' && (
                <ContextMenu.Item
                    leftIcon="download"
                    onSelect={() => {
                        void (async () => {
                            for (const album of items) {
                                const songs = await api.controller.getSongList({
                                    apiClientProps: { serverId: album._serverId },
                                    query: { albumIds: [album.id], limit: -1, startIndex: 0 },
                                });
                                for (const song of songs.items) await downloadOffline(song);
                            }
                        })().catch((e) => toast.error({ message: e.message }));
                    }}
                >
                    {t('site.download')}
                </ContextMenu.Item>
            )}
            <ShareAction ids={ids} itemType={LibraryItem.ALBUM} />
            <ContextMenu.Divider />
            <GoToAction items={items} />
            <ContextMenu.Divider />
            <EditMetadataAction albumIds={ids} />
            <GetInfoAction disabled={items.length === 0} items={items} />
        </ContextMenu.Content>
    );
};
