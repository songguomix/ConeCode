import { useMemo } from 'react';
import { FiCode, FiZap, FiAlertCircle, FiCheckSquare } from 'react-icons/fi';
import { useLanguageStore, useUIStore } from '../../stores';
import AppIcon from '../common/AppIcon';
import ChatInput from './ChatInput';

export default function NewChatHero() {
  const { t } = useLanguageStore();
  const setInputContent = useUIStore((s) => s.setInputContent);

  const h = new Date().getHours();
  const greetingKey =
    h >= 5 && h < 12 ? 'homeGreetingMorning' :
    h >= 12 && h < 18 ? 'homeGreetingAfternoon' :
    h >= 18 && h < 23 ? 'homeGreetingEvening' :
    'homeGreetingNight';
  const greetingText = t(greetingKey);

  const suggestions = useMemo(() => [
    {
      icon: <FiCode size={13} className="text-blue-500 shrink-0" />,
      labelKey: 'promptExplainArch',
      prompt: t('promptExplainArch'),
    },
    {
      icon: <FiZap size={13} className="text-amber-500 shrink-0" />,
      labelKey: 'promptBuildFeature',
      prompt: t('promptBuildFeature'),
    },
    {
      icon: <FiAlertCircle size={13} className="text-red-500 shrink-0" />,
      labelKey: 'promptFindBugs',
      prompt: t('promptFindBugs'),
    },
    {
      icon: <FiCheckSquare size={13} className="text-emerald-500 shrink-0" />,
      labelKey: 'promptWriteTests',
      prompt: t('promptWriteTests'),
    },
  ], [t]);

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-4 py-8 max-w-[840px] mx-auto w-full my-auto min-w-0">
      {/* Brand & Greeting */}
      <div className="flex flex-col items-center text-center mb-6 select-none">
        <div className="w-12 h-12 shrink-0 rounded-2xl overflow-hidden border border-[var(--glass-border)] shadow-xs flex items-center justify-center mb-4">
          <AppIcon size={48} className="w-full h-full object-cover" />
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold font-serif text-[var(--text-primary)] tracking-tight">
          {greetingText}
        </h1>
      </div>

      {/* Centered ChatInput */}
      <div className="w-full">
        <ChatInput centered />
      </div>

      {/* Quick Suggestion Chips */}
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2 max-w-[760px]">
        {suggestions.map((item) => (
          <button
            key={item.labelKey}
            onClick={() => setInputContent(item.prompt)}
            className="flex items-center gap-2 px-3.5 py-1.5 rounded-full text-[12px] bg-[var(--glass-card)] hover:bg-[var(--bg-2)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--glass-border)] hover:border-[color-mix(in_srgb,var(--accent)_40%,transparent)] shadow-2xs transition-colors cursor-pointer"
          >
            {item.icon}
            <span className="font-medium">{t(item.labelKey)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
