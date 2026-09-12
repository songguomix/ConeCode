import { FiFolder, FiFile, FiChevronRight, FiChevronDown, FiX, FiFolderPlus } from 'react-icons/fi';
import { useWorkspaceStore, useLanguageStore } from '../../stores';
import type { FileItem } from '../../stores/workspace.store';
import { rootLabel } from '../../core/workspace/roots';

export default function FileTree() {
  const {
    files, extraRoots, selectedFile, toggleExpand, selectFile, closeFile,
    openFolder, addRootFromDialog, removeRoot, rootPath, allRoots,
  } = useWorkspaceStore();
  const { t } = useLanguageStore();

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

  return (
    <div className="p-1 text-sm">
      <RootSection
        path={rootPath} files={files} roots={roots} selectedFile={selectedFile}
        onToggle={toggleExpand} onSelect={selectFile}
        // The primary folder has no close button of its own — closing it would
        // mean closing the workspace, which "open folder" already does.
        trailing={selectedFile ? (
          <button onClick={closeFile} title={t('closeFile')}
            className="p-0.5 rounded hover:bg-[var(--bg-3)] text-[var(--text-muted)]">
            <FiX size={12} />
          </button>
        ) : null}
      />

      {extraRoots.map((root) => (
        <RootSection
          key={root.path} path={root.path} files={root.files} roots={roots}
          selectedFile={selectedFile} onToggle={toggleExpand} onSelect={selectFile}
          trailing={
            <button onClick={() => removeRoot(root.path)} title={t('removeFolder')}
              className="p-0.5 rounded hover:bg-[var(--bg-3)] text-[var(--text-muted)] hover:text-[var(--error)]">
              <FiX size={12} />
            </button>
          }
        />
      ))}

      <button onClick={() => addRootFromDialog()}
        className="mt-1 w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[12px] text-[var(--text-muted)] hover:bg-[var(--bg-2)] hover:text-[var(--text-secondary)] transition-colors">
        <FiFolderPlus size={12} /> {t('addFolder')}
      </button>
    </div>
  );
}

function RootSection({ path, files, roots, selectedFile, onToggle, onSelect, trailing }: {
  path: string;
  files: FileItem[];
  roots: string[];
  selectedFile: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="mb-1">
      <div
        className="px-2 py-1.5 text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider flex items-center justify-between gap-1"
        title={path}
      >
        {/* rootLabel disambiguates two folders that share a name, so the sidebar
            never shows "web" twice with no way to tell them apart. */}
        <span className="truncate">{rootLabel(path, roots)}</span>
        {trailing}
      </div>
      {files.map((item) => (
        <FileNode key={item.path} item={item} depth={0} selectedFile={selectedFile}
          onToggle={onToggle} onSelect={onSelect} />
      ))}
    </div>
  );
}

function FileNode({ item, depth, selectedFile, onToggle, onSelect }: {
  item: FileItem; depth: number; selectedFile: string | null;
  onToggle: (path: string) => void; onSelect: (path: string) => void;
}) {
  const isSelected = selectedFile === item.path;
  const indent = depth * 12;

  return (
    <div>
      <div
        onClick={() => item.isDirectory ? onToggle(item.path) : onSelect(item.path)}
        className={`flex items-center gap-1.5 px-2 py-1 rounded cursor-pointer transition-colors ${
          isSelected ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-2)]'
        }`}
        style={{ paddingLeft: `${indent + 8}px` }}
      >
        {item.isDirectory ? (
          item.expanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />
        ) : (
          <span className="w-3" />
        )}
        {item.isDirectory ? (
          <FiFolder size={14} className="text-yellow-500 shrink-0" />
        ) : (
          <FiFile size={14} className="text-[var(--text-muted)] shrink-0" />
        )}
        <span className="flex-1 truncate">{item.name}</span>
      </div>
      {item.isDirectory && item.expanded && item.children && (
        <div>
          {item.children.map((child) => (
            <FileNode key={child.path} item={child} depth={depth + 1} selectedFile={selectedFile}
              onToggle={onToggle} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}
