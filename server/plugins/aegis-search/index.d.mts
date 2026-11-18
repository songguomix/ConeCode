export function scanSearchResults(urls: string[]): Promise<{
  results: { hostname: string; decision: 'allow' | 'review' | 'block' }[];
}>;
