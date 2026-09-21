import { arrayMove } from '@dnd-kit/sortable';

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
