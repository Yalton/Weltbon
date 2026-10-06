import { useEffect } from 'react';

const APP_NAME = 'Weltbon';

/** Sets the tab title to `<page> · Weltbon`, or just `Weltbon` without a page. */
export function useDocumentTitle(page?: string) {
  useEffect(() => {
    document.title = page ? `${page} · ${APP_NAME}` : APP_NAME;
  }, [page]);
}
