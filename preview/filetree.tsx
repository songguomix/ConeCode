// Visual harness for the multi-folder file tree.
//   ?locale=zh|ja
import React from 'react';
import ReactDOM from 'react-dom/client';
import '../src/index.css';
import FileTree from '../src/components/layout/FileTree';
import { useWorkspaceStore } from '../src/stores/workspace.store';
import { useLanguageStore, type Locale } from '../src/stores/language.store';

const dir = (path: string, name: string, children: any[] = [], expanded = false) =>
  ({ name, path, isDirectory: true, expanded, children });
const file = (path: string, name: string) => ({ name, path, isDirectory: false });

useLanguageStore.setState({
  locale: (new URLSearchParams(location.search).get('locale') as Locale) || 'en',
});

useWorkspaceStore.setState({
  rootPath: '/Users/dev/work/web',
  files: [
    dir('/Users/dev/work/web/src', 'src', [
      file('/Users/dev/work/web/src/App.tsx', 'App.tsx'),
      file('/Users/dev/work/web/src/main.tsx', 'main.tsx'),
    ], true),
    file('/Users/dev/work/web/package.json', 'package.json'),
  ],
  extraRoots: [
    // A second folder, and a third whose name collides with the first — the
    // label should disambiguate those two.
    { path: '/Users/dev/work/api', files: [
      dir('/Users/dev/work/api/src', 'src', [file('/Users/dev/work/api/src/main.ts', 'main.ts')]),
      file('/Users/dev/work/api/go.mod', 'go.mod'),
    ] },
    { path: '/Users/dev/personal/web', files: [file('/Users/dev/personal/web/index.html', 'index.html')] },
  ],
  selectedFile: '/Users/dev/work/web/src/App.tsx',
});

function Harness() {
  return (
    <div className="min-h-screen bg-[var(--bg-1)] p-8">
      <div className="w-[260px] bg-[var(--bg-1)] border border-[var(--border)] rounded-xl overflow-hidden">
        <FileTree />
      </div>
    </div>
  );
}
ReactDOM.createRoot(document.getElementById('root')!).render(<Harness />);
