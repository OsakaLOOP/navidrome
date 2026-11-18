import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { DiscussionPanel } from './discussion-panel';
import { MetadataEditor } from './metadata-editor';

import { useAuthStore } from '/@/renderer/store';
import { Button } from '/@/shared/components/button/button';

export type EntityKind = 'album' | 'artist' | 'song';

export function EntityPanel({ id, kind }: { id: string; kind: EntityKind }) {
    const { t } = useTranslation();
    const isAdmin = useAuthStore((state) => state.currentServer?.isAdmin);
    const [editor, setEditor] = useState(false);
    return (
        <DiscussionPanel
            actions={
                isAdmin && (
                    <Button
                        aria-expanded={editor}
                        onClick={() => setEditor(!editor)}
                        size="compact-sm"
                        variant="subtle"
                    >
                        {t('site.metadata')}
                    </Button>
                )
            }
            id={id}
            kind={kind}
        >
            {editor && <MetadataEditor id={id} kind={kind} />}
        </DiscussionPanel>
    );
}
