/** Only buyer product pages for the product in the verified listing-details response. */
export function normalizeFlipkartProductUrl(value: unknown, productId: string): string | undefined {
  if (typeof value !== 'string' || value.length > 4096) return undefined;
  const url = value.startsWith('/')
    ? URL.parse(value, 'https://www.flipkart.com')
    : URL.parse(value);
  if (
    !url ||
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    (url.hostname !== 'www.flipkart.com' && url.hostname !== 'flipkart.com') ||
    url.username ||
    url.password ||
    url.port ||
    !/^\/(?:[^/]+\/)?p\/[a-z\d_-]+\/?$/iu.test(url.pathname) ||
    url.searchParams.getAll('pid').some((id) => id !== productId)
  )
    return undefined;
  url.protocol = 'https:';
  return url.href;
}
