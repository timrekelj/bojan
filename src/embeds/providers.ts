// URL → embed-friendly mirror rewrites, same approach as embeddo
// (https://github.com/aikenahac/embeddo src/lib/url-transforms.ts): match by
// host (subdomains included, e.g. vm.tiktok.com), replace the hostname, keep
// scheme/path/query. The reposted message keeps the mirror link and Discord's
// own embedder fetches it, which yields proper video players.
// Platforms not listed here (youtube, spotify, ...) already get good native
// embeds from Discord and are left alone.
export interface Provider {
  name: string;
  mirror: string;
}

const MIRRORS: [host: string, mirror: string, name: string][] = [
  ['x.com', 'fxtwitter.com', 'x'],
  ['twitter.com', 'fxtwitter.com', 'x'],
  ['instagram.com', 'kkinstagram.com', 'instagram'],
  ['instagr.am', 'kkinstagram.com', 'instagram'],
  ['tiktok.com', 'kktiktok.com', 'tiktok'],
  ['reddit.com', 'vxreddit.com', 'reddit'],
];

const URL_RE = /https?:\/\/[^\s<>"']+/i;

/** Remove code blocks (```...```) and inline code (`...`) from text. */
export function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

/** First URL in the text, if any. */
export function extractUrl(text: string): string | null {
  const m = text.match(URL_RE);
  return m ? m[0].replace(/[.,;!?)\]]+$/, '') : null;
}

/** First URL that is NOT inside a code block or inline code, if any. */
export function extractUrlOutsideCode(text: string): string | null {
  return extractUrl(stripCode(text));
}

export function detectProvider(url: string): Provider | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const [pattern, mirror, name] of MIRRORS) {
    if (host === pattern || host.endsWith(`.${pattern}`)) return { name, mirror };
  }
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

/** True for short share links that redirect (vm.tiktok.com/..., t.co/...). */
export function isShortLink(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 't.co' || /^(vm|vt)\.tiktok\.com$/.test(host);
  } catch {
    return false;
  }
}

/**
 * Short share links redirect to the canonical URL; resolve them so the mirror
 * gets a URL it understands. Falls back to the original URL on failure.
 */
export async function canonicalizeUrl(url: string): Promise<string> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36' },
    });
    clearTimeout(t);
    return res.url || url;
  } catch {
    return url;
  }
}
