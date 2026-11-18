import type { Album, AlbumArtist, Song } from '/@/shared/types/domain-types';

import dayjs from 'dayjs';
import 'dayjs/locale/en';
import 'dayjs/locale/ja';
import 'dayjs/locale/zh-cn';
import localizedFormat from 'dayjs/plugin/localizedFormat';
import relativeTime from 'dayjs/plugin/relativeTime';
import utc from 'dayjs/plugin/utc';
import formatDuration from 'format-duration';

import i18n from '/@/i18n/i18n';
import { Rating } from '/@/shared/components/rating/rating';

dayjs.extend(relativeTime);
dayjs.extend(utc);
dayjs.extend(localizedFormat);

const getDayjsLocale = (i18nLang: string): string => {
    const localeMap: Record<string, string> = {
        en: 'en',
        ja: 'ja',
        'zh-Hans': 'zh-cn',
    };

    return localeMap[i18nLang] || 'zh-cn';
};

// BCP 47 tags for Intl (differs from dayjs locale ids for some languages).
const getIntlLocale = (i18nLang: string): string => {
    const localeMap: Record<string, string> = {
        'zh-Hans': 'zh-CN',
    };

    return localeMap[i18nLang] ?? i18nLang;
};

const updateDayjsLocale = () => {
    const dayjsLocale = getDayjsLocale(i18n.language);
    dayjs.locale(dayjsLocale);
};

// Set initial locale
updateDayjsLocale();

// Listen for i18n language changes
i18n.on('languageChanged', updateDayjsLocale);

export const formatDateAbsolute = (key: null | string) => (key ? dayjs(key).format('ll') : '');

export const formatDateAbsoluteUTC = (key: null | string) =>
    key ? dayjs.utc(key).format('ll') : '';

const PARTIAL_ISO_YEAR = /^\d{4}$/;
const PARTIAL_ISO_YEAR_MONTH = /^\d{4}-\d{2}$/;

export const formatPartialIsoDateUTC = (key: null | string): string => {
    if (!key) {
        return '';
    }

    const trimmedKey = key.trim();
    const intlLocale = getIntlLocale(i18n.language);

    if (PARTIAL_ISO_YEAR.test(trimmedKey)) {
        const year = Number.parseInt(trimmedKey, 10);
        if (!Number.isFinite(year)) {
            return trimmedKey;
        }

        return new Intl.DateTimeFormat(intlLocale, { timeZone: 'UTC', year: 'numeric' }).format(
            new Date(Date.UTC(year, 0, 1)),
        );
    }

    if (PARTIAL_ISO_YEAR_MONTH.test(trimmedKey)) {
        const d = dayjs.utc(`${trimmedKey}-01`);
        if (!d.isValid()) {
            return trimmedKey;
        }

        return new Intl.DateTimeFormat(intlLocale, {
            month: 'long',
            timeZone: 'UTC',
            year: 'numeric',
        }).format(d.toDate());
    }

    return dayjs.utc(trimmedKey).format('ll');
};

export const formatHrDateTime = (key: null | string) => (key ? dayjs(key).format('lll') : '');

export const formatDateRelative = (key: null | string) => (key ? dayjs(key).fromNow() : '');

export const formatDurationString = (duration: number) => {
    const rawDuration = formatDuration(duration, { leading: false }).split(':');

    const formattedDuration = rawDuration.map((part) => {
        // Remove leading zero
        return part.replace(/^0/, '');
    });

    const parts: string[] = [];
    const len = rawDuration.length;

    if (len >= 1 && formattedDuration[len - 1] !== undefined) {
        parts.push(`${formattedDuration[len - 1]}${i18n.t('datetime.secondShort')}`);
    }
    if (len >= 2 && formattedDuration[len - 2]) {
        parts.unshift(`${formattedDuration[len - 2]}${i18n.t('datetime.minuteShort')}`);
    }
    if (len >= 3 && formattedDuration[len - 3]) {
        parts.unshift(`${formattedDuration[len - 3]}${i18n.t('datetime.hourShort')}`);
    }
    if (len >= 4 && formattedDuration[len - 4]) {
        parts.unshift(`${formattedDuration[len - 4]}${i18n.t('datetime.dayShort')}`);
    }

    return parts.join(' ');
};

export const formatDurationStringShort = (duration: number) => {
    const rawDuration = formatDuration(duration).split(':');

    if (rawDuration.length === 4) {
        return `${rawDuration[0]}${i18n.t('datetime.dayShort')} ${rawDuration[1]}${i18n.t('datetime.hourShort')}`;
    } else if (rawDuration.length === 3) {
        return `${rawDuration[0]}${i18n.t('datetime.hourShort')} ${rawDuration[1]}${i18n.t('datetime.minuteShort')}`;
    } else if (rawDuration.length === 2) {
        return `${rawDuration[0]}${i18n.t('datetime.minuteShort')} ${rawDuration[1]}${i18n.t('datetime.secondShort')}`;
    } else if (rawDuration.length === 1) {
        return `${rawDuration[0]}${i18n.t('datetime.secondShort')}`;
    }

    return rawDuration;
};

export const formatRating = (item: Album | AlbumArtist | Song) =>
    item.userRating !== null ? <Rating readOnly value={item.userRating} /> : null;

const SIZES = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

export const formatSizeString = (size?: number): string => {
    let count = 0;
    let finalSize = size ?? 0;
    while (finalSize > 1024) {
        finalSize /= 1024;
        count += 1;
    }

    return `${finalSize.toFixed(2)} ${SIZES[count]}`;
};
