import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { Category } from '../hooks/useCategories';

interface Props {
  category: Category;
  isCollapsed: boolean;
  onToggleCollapse: (id: string) => void;
  onRename: (category: Category) => void;
  onDelete: (category: Category) => void;
}

export function CategorySidebarItem({
  category,
  isCollapsed,
  onToggleCollapse,
  onRename,
  onDelete,
}: Props) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: category.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <li ref={setNodeRef} style={style} className="group">
      <div className="flex items-center rounded hover:bg-white/[0.03]">
        <button
          type="button"
          onClick={() => onToggleCollapse(category.id)}
          data-collapsed={isCollapsed ? 'true' : 'false'}
          aria-label={category.label}
          className="flex items-center gap-2 flex-1 py-1 pl-2 text-sm text-left"
          {...attributes}
          {...listeners}
        >
          <span aria-hidden className="w-3 inline-block text-ink-muted">
            {isCollapsed ? '▸' : '▾'}
          </span>
          {category.icon && <span aria-hidden>{category.icon}</span>}
          <span className="flex-1 truncate">{category.label}</span>
          <span className="text-ink-muted tabular-nums pr-1">{category.entryCount}</span>
        </button>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            aria-label={`Category actions for ${category.label}`}
            className="px-2 py-1 text-sm text-ink-muted hover:text-ink opacity-0 group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100"
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            ⋯
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={4}
              className="min-w-[8rem] rounded-md border border-line bg-panel p-1 shadow-lg z-50"
            >
              <DropdownMenu.Item
                onSelect={() => onRename(category)}
                className="px-2 py-1.5 text-sm rounded cursor-pointer outline-none data-[highlighted]:bg-white/5"
              >
                Rename
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={() => onDelete(category)}
                className="px-2 py-1.5 text-sm rounded cursor-pointer outline-none text-red-600 dark:text-red-400 data-[highlighted]:bg-white/5"
              >
                Delete
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </li>
  );
}
