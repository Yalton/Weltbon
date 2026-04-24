import { arrayMove } from '@dnd-kit/sortable';

/**
 * Pure helper: given a list of category ids and the active/over ids from a
 * dnd-kit DragEndEvent, return the new ordered id list.
 *
 * Exported for unit testing — dnd-kit's keyboard coordinate-getter is flaky
 * in jsdom, so we test the reorder math here and let the dnd-kit wiring be
 * covered by manual/UAT verification.
 */
export function computeNewCategoryOrder(
  ids: string[],
  activeId: string,
  overId: string,
): string[] {
  if (activeId === overId) return ids;
  const oldIdx = ids.indexOf(activeId);
  const newIdx = ids.indexOf(overId);
  if (oldIdx === -1 || newIdx === -1) return ids;
  return arrayMove(ids, oldIdx, newIdx);
}
