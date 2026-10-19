import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ChatImage, { MessageImages } from './ChatImage';

describe('chat images', () => {
  it('renders tool screenshot data as an image with bounded dimensions', () => {
    const html = renderToStaticMarkup(<MessageImages images={['data:image/png;base64,AAAA']} />);
    expect(html).toContain('<img');
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain('max-w-full');
  });
  it('does not load an unsafe image source', () => {
    const html = renderToStaticMarkup(<ChatImage src="javascript:alert(1)" alt="Screenshot" />);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('Screenshot');
  });
  it('does not render an empty image gallery', () => {
    expect(renderToStaticMarkup(<MessageImages />)).toBe('');
  });
});
