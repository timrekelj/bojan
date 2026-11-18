// URL → embed-friendly mirror rewrites, same approach as embeddo
// (https://github.com/aikenahac/embeddo src/lib/url-transforms.ts): the
// reposted message keeps the mirror link and Discord's own embedder fetches
// it, which yields proper video players (unlike an embed we build ourselves).
// Platforms not listed here (youtube, spotify, ...) already get good native
// embeds from Discord and are left alone.
export interface Provider {
  name: string;
  pattern: RegExp;
  mirror: string;
}

const PROVIDERS: Provider[] = [
  { name: 'x', pattern: /(?:twitter\.com|x\.com)\/[\w]+\/status\/\d+/i, mirror: 'fxtwitter.com' },
  { name: 'instagram', pattern: /(?:instagram\.com|instagr\.am)\/(p|reel|reels|tv)\/[\w-]+/i, mirror: 'kkinstagram.com' },
  { name: 'tiktok', pattern: /tiktok\.com\/@[\w.-]+\/video\/\d+/i, mirror: 'kktiktok.com' },
  { name: 'reddit', pattern: /reddit\.com\/r\/[\w]+\/comments\/[\w]+/i, mirror: 'vxreddit.com' },
];

const URL_RE = /https?:\/\/[^\s<>"']+/i;

/** First URL in the text, if any. */
export function extractUrl(text: string): string | null {
  const m = text.match(URL_RE);
  return m ? m[0].replace(/[.,;!?)\]]+$/, '') : null;
}

export function detectProvider(url: string): Provider | null {
  for (const p of PROVIDERS) if (p.pattern.test(url)) return p;
  return null;
}

/** Rewrite the URL's host to the provider's mirror, preserving path and query. */
export function transformUrl(url: string): string | null {
  const provider = detectProvider(url);
  if (!provider) return null;
  try {
    const u = new URL(url);
    u.hostname = provider.mirror;
    return u.toString();
  } catch {
    return null;
  }
}
