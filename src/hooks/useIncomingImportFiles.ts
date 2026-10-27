import { useEffect, useRef } from 'react';
import { HANDOVER_EVENT, takePending } from '@/lib/unified-import/pending-files';
import type { UnifiedImportTypeId } from '@/lib/unified-import/types';

/**
 * Lets an existing import flow receive files dropped in the unified import zone.
 * `onFiles` must run the SAME code path as choosing the file by hand (same parser, same preview).
 * Delivers files that were stored before the flow mounted (route change) and while it is mounted.
 */
export function useIncomingImportFiles(id: UnifiedImportTypeId, onFiles: (files: File[]) => void): void {
  const handler = useRef(onFiles);
  handler.current = onFiles;

  useEffect(() => {
    const deliver = () => {
      const files = takePending(id);
      if (files.length > 0) handler.current(files);
    };
    const onEvent = (e: Event) => {
      if ((e as CustomEvent<{ id: UnifiedImportTypeId }>).detail?.id === id) deliver();
    };
    deliver();
    window.addEventListener(HANDOVER_EVENT, onEvent);
    return () => window.removeEventListener(HANDOVER_EVENT, onEvent);
  }, [id]);
}
