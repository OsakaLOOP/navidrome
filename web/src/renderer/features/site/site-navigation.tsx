import { useTranslation } from 'react-i18next';

import { useRoomOverview } from './room';
import styles from './room.module.css';

import { SidebarItem } from '/@/renderer/features/sidebar/components/sidebar-item';
import { Icon } from '/@/shared/components/icon/icon';

/** 站点侧栏专属导航：一起听（带统一图标与活跃人数角标）、离线音乐与账号 */
export function SiteNavigation() {
    const { t } = useTranslation();
    const { activeCount, joined, onlineCount } = useRoomOverview();
    if (window.SERVER_NAME !== 'ndFork') return null;

    return (
        <>
            <SidebarItem active={joined} to="/together">
                <div className={styles.navItemInner}>
                    <div className={styles.navItemLabel}>
                        <Icon
                            color={joined ? 'primary' : undefined}
                            icon="listenTogether"
                            size="lg"
                        />
                        <span>{t('site.listenTogether')}</span>
                    </div>
                    {onlineCount > 0 && (
                        <span
                            className={styles.navBadge}
                            title={t('together.onlineRatio', {
                                members: activeCount,
                                online: onlineCount,
                            })}
                        >
                            {activeCount}/{onlineCount}
                        </span>
                    )}
                </div>
            </SidebarItem>
            <SidebarItem to="/offline">
                <div className={styles.navItemLabel}>
                    <Icon icon="download" size="lg" />
                    <span>{t('site.offlineMusic')}</span>
                </div>
            </SidebarItem>
            <SidebarItem to="/account">
                <div className={styles.navItemLabel}>
                    <Icon icon="users" size="lg" />
                    <span>{t('site.account')}</span>
                </div>
            </SidebarItem>
        </>
    );
}
