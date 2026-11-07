import {
    ImageArgs,
    ImageRequest,
    LibraryItem,
    ReplaceApiClientProps,
} from '/@/shared/types/domain-types';

export const getMediaImageRequest = ({
    apiClientProps: { server },
    baseUrl,
    query,
}: ReplaceApiClientProps<ImageArgs>): ImageRequest | null => {
    if (!server?.credential || !query.id) return null;

    let id = query.id.split('&')[0];
    if (!/^(al|ar|mf|pl|ra|dc)-/.test(id)) {
        const prefixes: Partial<Record<LibraryItem, string>> = {
            [LibraryItem.ALBUM]: 'al',
            [LibraryItem.ALBUM_ARTIST]: 'ar',
            [LibraryItem.PLAYLIST]: 'pl',
            [LibraryItem.RADIO_STATION]: 'ra',
        };
        id = `${prefixes[query.itemType] || 'mf'}-${id}`;
    }
    const path = `/media/cover/${encodeURIComponent(id)}/${query.size || 0}/fit`;

    return {
        cacheKey: [server.id, baseUrl || '', path].join(':'),
        url: `${baseUrl || server.url}${path}?${server.credential}&v=1.16.1&c=ndFork`,
    };
};
