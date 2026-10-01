import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FiFolder, FiFile, FiChevronRight, FiChevronDown, FiFolderPlus, FiFilePlus,
  FiRefreshCw, FiMinusSquare,
} from 'react-icons/fi';
import { useWorkspaceStore, useLanguageStore, useAiHighlightsStore } from '../../stores';
import type { FileItem } from '../../stores/workspace.store';
import { rootLabel } from '../../core/workspace/roots';

interface MenuState {
  x: number;
  y: number;
  targetPath: string;
  isDirectory: boolean;
  isRoot: boolean;
}

export default function FileTree() {
  const {
    files, extraRoots, selectedFile, toggleExpand, collapseAll, selectFile,
    openFolder, addRootFromDialog, removeRoot, rootPath, allRoots,
    createFile, createFolder, renamePath, deletePath, refreshFiles,
  } = useWorkspaceStore();
  const aiLines = useAiHighlightsStore((s) => s.lines);
  const { t } = useLanguageStore();
  const [filter, setFilter] = useState('');
  // Inline composer: { parentDir, kind } for create, or { renamePath } for rename.
  const [creating, setCreating] = useState<{ parentDir: string; kind: 'file' | 'folder' } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [busy, setBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  // Keep the context menu on screen.
  const menuPos = useMemo(() => {
    if (!menu) return null;
    return { x: Math.min(menu.x, window.innerWidth - 190), y: Math.min(menu.y, window.innerHeight - 220) };
  }, [menu]);

  if (!rootPath) {
    return (
      <div className="px-2 py-2">
        <button onClick={openFolder}
          className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--accent-soft)] text-[var(--accent)] hover:bg-[var(--accent)]/20 text-[13px] transition-colors">
          {t('openFolder')}
        </button>
      </div>
    );
  }

  const roots = allRoots();
  const q = filter.trim().toLowerCase();
  const matches = (name: string) => !q || name.toLowerCase().includes(q);

  const openMenu = (e: React.MouseEvent, targetPath: string, isDirectory: boolean, isRoot = false) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, targetPath, isDirectory, isRoot });
  };

  const runRename = async (oldPath: string, newName: string) => {
    if (!newName.trim()) { setRenaming(null); return; }
    setBusy(true);
    try {
      const result = await renamePath(oldPath, newName.trim());
      if (!result) window.alert(t('renameFailed'));
    } finally {
      setBusy(false);
      setRenaming(null);
    }
  };

  const runCreate = async (name: string) => {
    if (!creating) return;
    if (!name.trim()) { setCreating(null); return; }
    setBusy(true);
    try {
      const ok = creating.kind === 'file'
        ? await createFile(creating.parentDir, name.trim())
        : await createFolder(creating.parentDir, name.trim());
      if (!ok) window.alert(t('createFailed'));
    } finally {
      setBusy(false);
      setCreating(null);
    }
  };

  const runDelete = async () => {
    if (!menu) return;
    const label = menu.targetPath.split('/').pop() || menu.targetPath;
    if (!window.confirm(t('deleteConfirm').replace('{name}', label))) return;
    setBusy(true);
    try {
      const ok = await deletePath(menu.targetPath, menu.isDirectory);
      if (!ok) window.alert(t('deleteFailed'));
    } finally {
      setBusy(false);
      setMenu(null);
    }
  };

  const copyPath = async (absolute: boolean) => {
    if (!menu) return;
    try {
      await navigator.clipboard.writeText(
        absolute ? menu.targetPath : menu.targetPath.replace(rootPath + '/', ''),
      );
    } catch {}
    setMenu(null);
  };

  const menuItems: { label: string; action: () => void; danger?: boolean }[] = menu ? [
    ...(menu.isDirectory ? [
      { label: t('newFile'), action: () => { setCreating({ parentDir: menu.targetPath, kind: 'file' }); setMenu(null); } },
      { label: t('newFolder'), action: () => { setCreating({ parentDir: menu.targetPath, kind: 'folder' }); setMenu(null); } },
    ] : []),
    ...(!menu.isRoot ? [
      { label: t('rename'), action: () => { setRenaming(menu.targetPath); setMenu(null); } },
      { label: t('delete'), action: runDelete, danger: true },
    ] : []),
    { label: t('copyPath'), action: () => copyPath(true) },
    { label: t('copyRelativePath'), action: () => copyPath(false) },
  ] : [];

  const shared = {
    creating, renaming, busy, menu, selectedFile, aiLines,
    onToggle: toggleExpand, onSelect: selectFile, onMenu: openMenu,
    onSubmitCreate: runCreate, onCancelCreate: () => setCreating(null),
    onSubmitRename: runRename, onCancelRename: () => setRenaming(null),
    matches,
  };

  return (
    <div className="text-sm min-w-0">
      {/* Explorer toolbar — VS Code order: new file, new folder, refresh, collapse. */}
      <div className="flex items-center gap-0.5 px-1.5 py-1">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('explorerFilter')}
          spellCheck={false}
          className="flex-1 min-w-0 bg-[var(--bg-2)] border border-[var(--border)] rounded-lg px-2 py-1 text-[12px] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
        />
        <ToolBtn title={t('newFile')} onClick={() => setCreating({ parentDir: rootPath, kind: 'file' })}>
          <FiFilePlus size={13} />
        </ToolBtn>
        <ToolBtn title={t('newFolder')} onClick={() => setCreating({ parentDir: rootPath, kind: 'folder' })}>
          <FiFolderPlus size={13} />
        </ToolBtn>
        <ToolBtn title={t('refresh')} onClick={() => void refreshFiles()}>
          <FiRefreshCw size={13} />
        </ToolBtn>
        <ToolBtn title={t('collapseAll')} onClick={collapseAll}>
          <FiMinusSquare size={13} />
        </ToolBtn>
      </div>

      <div className="px-1 pb-2">
        <RootSection path={rootPath} files={files} roots={roots} {...shared}
          trailing={menu && menu.isRoot && menu.targetPath === rootPath ? undefined : (
            <button
              onContextMenu={(e) => openMenu(e, rootPath, true, true)}
              onClick={(e) => openMenu(e, rootPath, true, true)}
              title={t('explorerMore')}
              className="p-0.5 rounded hover:bg-[var(--bg-3)] text-[var(--text-muted)]"
            >
              <FiChevronDown size={12} />
            </button>
          )}
        />
        {extraRoots.map((root) => (
          <RootSection key={root.path} path={root.path} files={root.files} roots={roots} {...shared}
            trailing={
              <button onClick={() => removeRoot(root.path)} title={t('removeFolder')}
                className="p-0.5 rounded hover:bg-[var(--bg-3)] text-[var(--text-muted)] hover:text-[var(--error)]">
                <FiChevronDown size={12} />
              </button>
            }
          />
        ))}

        <button onClick={() => addRootFromDialog()}
          className="mt-1 w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[12px] text-[var(--text-muted)] hover:bg-[var(--bg-2)] hover:text-[var(--text-secondary)] transition-colors">
          <FiFolderPlus size={12} /> {t('addFolder')}
        </button>
      </div>

      {menu && menuPos && (
        <div ref={menuRef} onClick={(e) => e.stopPropagation()}
          className="fixed z-50 w-[180px] rounded-xl border border-[var(--border)] bg-[var(--bg-2)] shadow-xl py-1 overflow-hidden"
          style={{ left: menuPos.x, top: menuPos.y }}>
          {menuItems.map((item) => (
            <button key={item.label} onClick={item.action}
              className={`w-full text-left px-3 py-1.5 text-[12px] transition-colors ${
                item.danger ? 'text-[var(--error)] hover:bg-[var(--error)]/10' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-3)]'
              }`}>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ToolBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={title}
      className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-3)] transition-colors shrink-0">
      {children}
    </button>
  );
}

interface SharedProps {
  creating: { parentDir: string; kind: 'file' | 'folder' } | null;
  renaming: string | null;
  busy: boolean;
  selectedFile: string | null;
  aiLines: Record<string, number[]>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onMenu: (e: React.MouseEvent, path: string, isDir: boolean, isRoot?: boolean) => void;
  onSubmitCreate: (name: string) => void;
  onCancelCreate: () => void;
  onSubmitRename: (oldPath: string, name: string) => void;
  onCancelRename: () => void;
  matches: (name: string) => boolean;
}

function RootSection({ path, files, roots, trailing, ...shared }: {
  path: string;
  files: FileItem[];
  roots: string[];
  trailing?: React.ReactNode;
} & SharedProps) {
  return (
    <div className="mb-1">
      <div
        className="px-2 py-1.5 text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider flex items-center justify-between gap-1"
        title={path}
        onContextMenu={(e) => shared.onMenu(e, path, true, true)}
      >
        <span className="truncate">{rootLabel(path, roots)}</span>
        {trailing}
      </div>
      {shared.creating?.parentDir === path && (
        <InlineInput
          key={`create-${path}`}
          folder={shared.creating.kind === 'folder'}
          disabled={shared.busy}
          onSubmit={shared.onSubmitCreate}
          onCancel={shared.onCancelCreate}
          depth={0}
        />
      )}
      {files.map((item) => (
        <FileNode key={item.path} item={item} depth={0} {...shared} />
      ))}
    </div>
  );
}

function FileNode({ item, depth, ...shared }: {
  item: FileItem; depth: number;
} & SharedProps) {
  const isSelected = shared.selectedFile === item.path;
  const hasAi = !item.isDirectory && (shared.aiLines[item.path]?.length ?? 0) > 0;
  const indent = depth * 12;
  const visibleChildren = item.children?.filter((c) => shared.matches(c.name));

  if (!shared.matches(item.name) && !(visibleChildren?.length)) return null;

  return (
    <div>
      {shared.renaming === item.path ? (
        <InlineInput
          key={`rename-${item.path}`}
          initial={item.name}
          disabled={shared.busy}
          onSubmit={(name) => shared.onSubmitRename(item.path, name)}
          onCancel={shared.onCancelRename}
          depth={depth}
        />
      ) : (
        <div
          onClick={() => item.isDirectory ? shared.onToggle(item.path) : shared.onSelect(item.path)}
          onContextMenu={(e) => shared.onMenu(e, item.path, item.isDirectory)}
          className={`flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer transition-colors min-w-0 ${
            isSelected ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-2)]'
          }`}
          style={{ paddingLeft: `${indent + 8}px` }}
        >
          {item.isDirectory ? (
            item.expanded ? <FiChevronDown size={12} className="shrink-0" /> : <FiChevronRight size={12} className="shrink-0" />
          ) : (
            <span className="w-3 shrink-0" />
          )}
          {item.isDirectory ? (
            <FiFolder size={14} className="text-yellow-500 shrink-0" />
          ) : (
            <FiFile size={14} className="text-[var(--text-muted)] shrink-0" />
          )}
          <span className="flex-1 truncate min-w-0">{item.name}</span>
          {hasAi && (
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--success)] shrink-0" title="AI edited" />
          )}
        </div>
      )}
      {shared.creating?.parentDir === item.path && item.isDirectory && (
        <InlineInput
          key={`create-${item.path}`}
          folder={shared.creating.kind === 'folder'}
          disabled={shared.busy}
          onSubmit={shared.onSubmitCreate}
          onCancel={shared.onCancelCreate}
          depth={depth + 1}
        />
      )}
      {item.isDirectory && item.expanded && item.children && (
        <div>
          {(visibleChildren ?? item.children).map((child) => (
            <FileNode key={child.path} item={child} depth={depth + 1} {...shared} />
          ))}
        </div>
      )}
    </div>
  );
}

function InlineInput({ initial = '', folder, disabled, onSubmit, onCancel, depth }: {
  initial?: string;
  folder: boolean;
  disabled: boolean;
  onSubmit: (name: string) => void;
  onCancel: () => void;
  depth: number;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <div className="flex items-center gap-1.5 px-2 py-0.5" style={{ paddingLeft: `${depth * 12 + 8}px` }}>
      {folder ? <FiFolder size={14} className="text-yellow-500 shrink-0" /> : <FiFile size={14} className="text-[var(--text-muted)] shrink-0" />}
      <input
        ref={ref}
        value={value}
        disabled={disabled}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => onSubmit(value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit(value);
          if (e.key === 'Escape') onCancel();
        }}
        placeholder={folder ? 'folder-name' : 'file-name'}
        spellCheck={false}
        className="flex-1 min-w-0 bg-[var(--bg-2)] border border-[var(--accent)] rounded px-1.5 py-0.5 text-[12px] outline-none"
      />
    </div>
  );
}
