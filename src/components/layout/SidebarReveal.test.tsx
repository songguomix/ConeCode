import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import SidebarReveal from './SidebarReveal';

const render = (open: boolean, overlay = false) => renderToStaticMarkup(
  <SidebarReveal open={open} width={280} overlay={overlay} label="toggle" onToggle={() => {}}>
    <nav>sidebar body</nav>
  </SidebarReveal>,
);

describe('SidebarReveal', () => {
  it('does not mount the sidebar content while it is closed', () => {
    const html = render(false);
    expect(html).not.toContain('sidebar body');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('tabindex="0"');
  });

  it('marks the panel inert for assistive tech while it is closed', () => {
    expect(render(false)).toContain('aria-hidden="true"');
  });

  it('mounts the content and hides the reveal button once open', () => {
    const html = render(true);
    expect(html).toContain('sidebar body');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('data-open="true"');
  });

  it('adds the scrim only for the overlay layout', () => {
    expect(render(false, true)).not.toContain('sidebar-reveal-scrim');
    expect(render(true, true)).toContain('sidebar-reveal-scrim');
  });
});
