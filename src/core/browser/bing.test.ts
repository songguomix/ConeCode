import { describe, expect, it } from 'vitest';
import { bingSearchUrl, parseBingResults } from './bing';
describe('Bing search', () => {
  it('encodes query operators and Chinese text', () => {
    expect(new URL(bingSearchUrl('沈阳 site:weather.com.cn')).searchParams.get('q')).toBe('沈阳 site:weather.com.cn');
  });
  it('decodes redirect destinations, deduplicates and keeps snippets scoped', () => {
    const destination = 'https://example.com/docs?utm_source=bing';
    const encoded = 'a1' + Buffer.from(destination).toString('base64url');
    const html = `<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=${encoded}&amp;ntb=1">Official docs</a></h2><p>Useful documentation.</p></li>
      <li class='b_algo'><h2><a href='https://second.com/'>Second result</a></h2></li>
      <li class="b_algo"><h2><a href="https://example.com/docs">Duplicate</a></h2></li>
      <li class="b_algo"><h2><a href="javascript:alert(1)">Invalid</a></h2></li>`;
    expect(parseBingResults(html)).toEqual([
      { title: 'Official docs', link: 'https://example.com/docs', snippet: 'Useful documentation.' },
      { title: 'Second result', link: 'https://second.com/' },
    ]);
  });
  it('removes hidden markup, decodes numeric entities and ignores footer paragraphs', () => {
    const html = `<li class="b_algo"><h2><a href="https://example.com/">Docs &#x2014; API</a></h2>
      <p><style>.hidden{display:none}</style><script>tracking()</script>Updated &#0183;&#32;Works with &#x4E2D;&#x6587; &amp; JS.</p></li>
      <li class="b_algo"><h2><a href="https://second.com/">Second result</a></h2></li>
      <footer><p>Privacy footer must not become a snippet.</p></footer>`;
    expect(parseBingResults(html)).toEqual([
      { title: 'Docs — API', link: 'https://example.com/', snippet: 'Updated · Works with 中文 & JS.' },
      { title: 'Second result', link: 'https://second.com/' },
    ]);
  });

  it('does not present challenge pages as results', () => {
    expect(parseBingResults('<html>Verify you are human</html>')).toEqual([]);
  });
});
