import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import {
  useCategories,
  useDeleteCategory,
  useReorderCategories,
  type Category,
} from '../hooks/useCategories';
import { CategorySidebarItem } from './CategorySidebarItem';
import { CategoryManageDialog } from './CategoryManageDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { EmptyState } from './EmptyState';
import { computeNewCategoryOrder } from './categoryReorder';

function SidebarNavLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      end
      className={({ isActive }) =>
        [
          'block rounded px-2 py-1.5 text-sm',
          isActive
            ? 'bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)] font-medium'
            : 'text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-900',
        ].join(' ')
      }
    >
      {children}
    </NavLink>
  );
}

export function Sidebar({ universeId }: { universeId: string }) {
  const { data, isLoading, error } = useCategories(universeId);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Category | null>(null);

  const reorder = useReorderCategories(universeId);
  const deleteCategory = useDeleteCategory(universeId);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const toggle = (id: string) =>
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));

  const openCreate = () => {
    setEditingCategory(null);
    setDialogOpen(true);
  };

  const openRename = (category: Category) => {
    setEditingCategory(category);
    setDialogOpen(true);
  };

  const handleDragEnd = (e: DragEndEvent) => {
    if (!e.over || !data) return;
    const activeId = String(e.active.id);
    const overId = String(e.over.id);
    if (activeId === overId) return;
    const currentIds = data.categories.map((c) => c.id);
    const nextIds = computeNewCategoryOrder(currentIds, activeId, overId);
    if (nextIds === currentIds) return;
    reorder.mutate(nextIds);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    await deleteCategory.mutateAsync(deleteTarget.id);
    setDeleteTarget(null);
  };

  return (
    <nav
      aria-label="Universe navigation"
      className="w-64 shrink-0 border-r border-neutral-200 dark:border-neutral-800 h-full overflow-y-auto py-4"
    >
      <div className="px-3 pb-3 border-b border-neutral-200 dark:border-neutral-800 space-y-1">
        <SidebarNavLink to={`/universes/${universeId}/entries`}>Entries</SidebarNavLink>
        <SidebarNavLink to={`/universes/${universeId}/graph`}>Graph</SidebarNavLink>
        <SidebarNavLink to={`/universes/${universeId}/timeline`}>Timeline</SidebarNavLink>
        <SidebarNavLink to={`/universes/${universeId}/issues`}>Issues</SidebarNavLink>
        <SidebarNavLink to={`/universes/${universeId}/stats`}>Stats</SidebarNavLink>
      </div>

      <div className="mt-4 px-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs uppercase tracking-wide text-neutral-500">Categories</h3>
          <button
            type="button"
            onClick={openCreate}
            aria-label="New category"
            className="text-xs px-2 py-0.5 rounded text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-900"
          >
            + New
          </button>
        </div>

        {isLoading && (
          <p className="text-sm mt-2 text-neutral-500">Loading…</p>
        )}
        {error && (
          <p className="text-sm mt-2 text-red-500">Failed to load</p>
        )}

        {data && data.categories.length === 0 && (
          <div className="mt-2">
            <EmptyState
              title="Group your entries"
              body="Categories let you organise entries into folders that show up here."
              action={
                <button
                  type="button"
                  onClick={openCreate}
                  className="bg-[color:var(--color-accent)] text-white text-sm font-medium px-4 py-2 rounded-md hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2"
                >
                  Add a category
                </button>
              }
            />
            <ul className="mt-2 space-y-0.5" data-testid="category-list">
              <li>
                <div className="flex items-center justify-between py-1 px-2 text-sm text-neutral-500">
                  <span className="pl-5">Uncategorized</span>
                  <span className="tabular-nums">{data.uncategorizedCount}</span>
                </div>
              </li>
            </ul>
          </div>
        )}
        {data && data.categories.length > 0 && (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={data.categories.map((c) => c.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="mt-2 space-y-0.5" data-testid="category-list">
                {data.categories.map((c) => (
                  <CategorySidebarItem
                    key={c.id}
                    category={c}
                    isCollapsed={!!collapsed[c.id]}
                    onToggleCollapse={toggle}
                    onRename={openRename}
                    onDelete={setDeleteTarget}
                  />
                ))}
                <li>
                  <div className="flex items-center justify-between py-1 px-2 text-sm text-neutral-500">
                    <span className="pl-5">Uncategorized</span>
                    <span className="tabular-nums">{data.uncategorizedCount}</span>
                  </div>
                </li>
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </div>

      <CategoryManageDialog
        universeId={universeId}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initialCategory={editingCategory}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={deleteTarget ? `Delete "${deleteTarget.label}"?` : 'Delete category'}
        body="Entries in this category will become uncategorized."
        confirmLabel="Delete"
        destructive
        onConfirm={confirmDelete}
      />
    </nav>
  );
}
