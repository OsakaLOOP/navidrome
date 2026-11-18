import { useTranslation } from 'react-i18next';

import { SidebarItem } from '/@/renderer/features/sidebar/components/sidebar-item';

export function SiteNavigation() {
    const { t } = useTranslation();
    if (window.SERVER_NAME !== 'ndFork') return null;
    return (
        <>
            <SidebarItem to="/together">{t('site.listenTogether')}</SidebarItem>
            <SidebarItem to="/offline">{t('site.offlineMusic')}</SidebarItem>
            <SidebarItem to="/account">{t('site.account')}</SidebarItem>
        </>
    );
}
