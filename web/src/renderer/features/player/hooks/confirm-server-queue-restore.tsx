import { closeModal, openModal } from '@mantine/modals';
import { t } from 'i18next';

import { ConfirmModal } from '/@/shared/components/modal/modal';
import { Text } from '/@/shared/components/text/text';

export function confirmServerQueueRestore(shared: boolean, restore: () => void) {
    const modalId = 'restore-server-queue';
    openModal({
        children: (
            <ConfirmModal
                labels={{ cancel: t('common.cancel'), confirm: t('common.confirm') }}
                onConfirm={() => {
                    closeModal(modalId);
                    restore();
                }}
            >
                <Text>
                    {t(shared ? 'site.restoreSharedQueueConfirm' : 'site.restoreQueueConfirm')}
                </Text>
            </ConfirmModal>
        ),
        modalId,
        title: t('player.restoreQueueFromServer'),
    });
}
