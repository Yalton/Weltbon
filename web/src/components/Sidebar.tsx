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
import { computeNewCategoryOrder } from './categoryReorder';

function NavIcon({ d, circle }: { d?: string; circle?: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0 opacity-80"
    >
      {circle ? <circle cx="8" cy="8" r="5.5" /> : <path d={d} />}
    </svg>
  );
}

const NAV_ICONS: Record<string, React.ReactNode> = {
  Entries: <NavIcon circle />,
  Graph: <NavIcon d="M4 12l4-8 4 8M4 12h8M4 12a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0zm8 0a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0zM8 4a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z" />,
  Timeline: <NavIcon d="M8 4v4l2.5 2.5M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0z" />,
  Stats: <NavIcon d="M3 13V8m5 5V3m5 10v-7" />,
  Diagrams: <NavIcon d="M3 3h4v4H3zM9 9h4v4H9zM7 5h4M5 7v4h4" />,
  Maps: <NavIcon d="M2 4l4-1.5L10 4l4-1.5v9L10 13 6 11.5 2 13zM6 2.5v9M10 4v9" />,
  Media: <NavIcon d="M2 3h12v10H2zM2 10l3.5-3 4 4M10 8.5L14 5.5M6 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2z" />,
  Dictionary: <NavIcon d="M4 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM3 11h10M6 5h4" />,
  Issues: <NavIcon d="M4 2v12M4 3h8l-1.5 2.5L12 8H4" />,
};

function SidebarNavLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      end
      className={({ isActive }) =>
        [
          'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors duration-150',
          isActive
            ? 'text-indigo-100 bg-gradient-to-r from-indigo-400/15 to-indigo-400/5 shadow-[inset_0_0_0_1px_rgb(165_180_252/0.18),0_0_18px_rgb(129_140_248/0.12)] font-medium'
            : 'text-ink-secondary hover:bg-white/5 hover:text-ink',
        ].join(' ')
      }
    >
      {NAV_ICONS[typeof children === 'string' ? children : ''] ?? null}
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
      className="w-64 shrink-0 border-r border-white/10 bg-[color:var(--color-chrome)] backdrop-blur-md h-full overflow-y-auto py-4 flex flex-col"
    >
      <div className="px-3 pb-3 border-b border-white/10 space-y-0.5">
        <SidebarNavLink to={`/universes/${universeId}/entries`}>Entries</SidebarNavLink>
        <SidebarNavLink to={`/universes/${universeId}/graph`}>Graph</SidebarNavLink>
        <SidebarNavLink to={`/universes/${universeId}/timeline`}>Timeline</SidebarNavLink>
        <SidebarNavLink to={`/universes/${universeId}/stats`}>Stats</SidebarNavLink>
        <SidebarNavLink to={`/universes/${universeId}/diagrams`}>Diagrams</SidebarNavLink>
        <SidebarNavLink to={`/universes/${universeId}/maps`}>Maps</SidebarNavLink>
        <SidebarNavLink to={`/universes/${universeId}/assets`}>Media</SidebarNavLink>
        <SidebarNavLink to={`/universes/${universeId}/dictionary`}>Dictionary</SidebarNavLink>
        <SidebarNavLink to={`/universes/${universeId}/issues`}>Issues</SidebarNavLink>
      </div>

      <div className="mt-4 px-3">
        <div className="flex items-center justify-between">
          <h3 className="text-[10px] uppercase tracking-[0.14em] text-ink-muted">Categories</h3>
          <button
            type="button"
            onClick={openCreate}
            aria-label="New category"
            className="text-xs px-2 py-0.5 rounded text-indigo-300 hover:text-indigo-200 hover:bg-white/5"
          >
            + New
          </button>
        </div>

        {isLoading && (
          <p className="text-sm mt-2 text-ink-muted">Loading…</p>
        )}
        {error && (
          <p className="text-sm mt-2 text-red-500">Failed to load</p>
        )}

        {data && data.categories.length === 0 && (
          <div className="mt-2">
            <div className="mt-3 rounded-lg border border-dashed border-white/15 p-3 text-center">
              <p className="text-xs leading-relaxed text-ink-secondary">
                Categories let you organise entries into folders.
              </p>
              <button
                type="button"
                onClick={openCreate}
                className="mt-2 rounded-lg bg-white/5 border border-glass-border px-3 py-1.5 text-xs text-ink-secondary hover:bg-white/10 hover:text-ink"
              >
                Add a category
              </button>
            </div>
            <ul className="mt-2 space-y-0.5" data-testid="category-list">
              <li>
                <div className="flex items-center justify-between py-1 px-2 text-sm text-ink-muted">
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
                  <div className="flex items-center justify-between py-1 px-2 text-sm text-ink-muted">
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
