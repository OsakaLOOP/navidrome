import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import {
    SettingOption,
    SettingsSection,
} from '/@/renderer/features/settings/components/settings-section';
import { useListenTogetherSettings, useSettingsStoreActions } from '/@/renderer/store';
import { Switch } from '/@/shared/components/switch/switch';

/** 一起听提醒设置 */
export const ListenTogetherSettings = memo(() => {
    const { t } = useTranslation();
    const settings = useListenTogetherSettings();
    const { setSettings } = useSettingsStoreActions();

    const options: SettingOption[] = [
        {
            control: (
                <Switch
                    aria-label={t('together.settingNotifyStart')}
                    checked={settings.notifyOnStart}
                    onChange={(event) => {
                        setSettings({
                            listenTogether: {
                                notifyOnStart: event.currentTarget.checked,
                            },
                        });
                    }}
                />
            ),
            description: t('together.settingNotifyStartDesc'),
            title: t('together.settingNotifyStart'),
        },
        {
            control: (
                <Switch
                    aria-label={t('together.settingNotifyBroadcast')}
                    checked={settings.notifyOnBroadcast}
                    onChange={(event) => {
                        setSettings({
                            listenTogether: {
                                notifyOnBroadcast: event.currentTarget.checked,
                            },
                        });
                    }}
                />
            ),
            description: t('together.settingNotifyBroadcastDesc'),
            title: t('together.settingNotifyBroadcast'),
        },
    ];

    return <SettingsSection options={options} title={t('site.listenTogether')} />;
});
