import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import RsiFolderHint from './RsiFolderHint';

const t = (key: string) => key;
const noop = () => {};

describe('RsiFolderHint', () => {
  it('lists only folders and marks the active one with a hint', () => {
    const markup = renderToStaticMarkup(
      <RsiFolderHint
        t={t}
        paths={['/work/alpha', '/work/beta']}
        activePath="/work/alpha"
        error={null}
        onAdd={noop}
        onRemove={noop}
        onDismissError={noop}
      />,
    );
    expect(markup).toContain('alpha');
    expect(markup).toContain('beta');
    expect(markup).toContain('rsiFolderActiveHint');
    // The active folder is called out exactly once, never every folder.
    expect(markup.match(/rsiFolderActiveHint/g)).toHaveLength(1);
    expect(markup).toContain('aria-current="true"');
  });

  it('offers an add-folder action when nothing is selected', () => {
    const markup = renderToStaticMarkup(
      <RsiFolderHint
        t={t}
        paths={[]}
        activePath={null}
        error={null}
        onAdd={noop}
        onRemove={noop}
        onDismissError={noop}
      />,
    );
    expect(markup).toContain('rsiFoldersEmpty');
    expect(markup).toContain('addFolder');
    expect(markup).not.toContain('files');
  });

  it('surfaces folder errors without hiding the folder controls', () => {
    const markup = renderToStaticMarkup(
      <RsiFolderHint
        t={t}
        paths={['/work/alpha']}
        activePath="/work/alpha"
        error="addFolder_duplicate"
        onAdd={noop}
        onRemove={noop}
        onDismissError={noop}
      />,
    );
    expect(markup).toContain('addFolder_duplicate');
    expect(markup).toContain('alpha');
  });
});
