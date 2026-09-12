// Visual harness for the memory panel. Seeded with entries in every kind,
// including legacy ones so the migration path is visible too.
//   ?locale=zh|ja  — check the other translations
import React from 'react';
import ReactDOM from 'react-dom/client';
import '../src/index.css';
import MemoryPanel from '../src/components/memory/MemoryPanel';
import { useMemoryStore } from '../src/stores/memory.store';
import { useWorkspaceStore } from '../src/stores/workspace.store';
import { useLanguageStore, type Locale } from '../src/stores/language.store';
import { migrateEntries } from '../src/core/memory/memory';

(window as any).electronAPI = {
  memory: { list: async () => [], save: async () => true },
};

const ROOT = '/Users/dev/conecode';
useWorkspaceStore.setState({ rootPath: ROOT });

const locale = (new URLSearchParams(location.search).get('locale') as Locale) || 'en';
useLanguageStore.setState({ locale });

const now = Date.now();
// Deliberately mixed: current kinds plus the two retired ones, to prove stored
// memory written before this change still shows up in the right section.
useMemoryStore.setState({
  loaded: true,
  entries: migrateEntries([
    { id: '1', kind: 'workflow', hits: 4, scope: 'global', createdAt: now, updatedAt: now,
      text: 'Run the test suite and report real output before calling a task done',
      why: 'claimed done once on work that had never been run' },
    { id: '2', kind: 'workflow', hits: 2, scope: 'global', createdAt: now, updatedAt: now,
      text: 'Offer large unrequested features as a recommendation instead of building them' },
    { id: '3', kind: 'preference', hits: 1, scope: 'global', createdAt: now, updatedAt: now,
      text: 'LEGACY preference entry — should appear under How to work' },
    { id: '4', kind: 'project', hits: 3, scope: 'project', projectPath: ROOT, createdAt: now, updatedAt: now,
      text: 'Pure logic lives in src/core so it is testable; anything touching the OS goes in electron/',
      why: 'the split is what let the preview engine be unit tested' },
    { id: '5', kind: 'fact', hits: 1, scope: 'project', projectPath: ROOT, createdAt: now, updatedAt: now,
      text: 'LEGACY project-scoped fact — should appear under About this project' },
    { id: '6', kind: 'project', hits: 1, scope: 'project', projectPath: '/some/other/repo', createdAt: now, updatedAt: now,
      text: 'ANOTHER PROJECT — must NOT be visible here' },
    { id: '7', kind: 'codeIssue', hits: 5, scope: 'global', createdAt: now, updatedAt: now,
      text: 'Ships React effects with missing dependency arrays' },
    { id: '8', kind: 'style', hits: 9, scope: 'global', createdAt: now, updatedAt: now,
      text: 'Writes in Chinese and gives very short instructions — answer in Chinese' },
  ]),
});

function Harness() {
  const { t } = useLanguageStore();
  return (
    <div className="min-h-screen bg-[var(--bg-0)] p-8">
      <div className="max-w-[560px]"><MemoryPanel t={t} /></div>
    </div>
  );
}
ReactDOM.createRoot(document.getElementById('root')!).render(<Harness />);
