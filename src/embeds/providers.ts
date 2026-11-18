export interface EmbedMeta {
  provider: string;
  url: string;
  title?: string;
  description?: string;
  author?: string;
  siteName?: string;
  image?: string;
  video?: string;
  color?: number;
}

interface Provider {
  name: string;
  pattern: RegExp;
  color: number;
  oembed?: (url: string) => string;
}

// Inspired by https://github.com/aikenahac/embeddo — keyless oEmbed where the
// platform offers it, OpenGraph scraping as a universal fallback (needed for
// X/Twitter and Instagram, whose oEmbed endpoints require app credentials).
const PROVIDERS: Provider[] = [
  { name: 'x', pattern: /(?:twitter\.com|x\.com)\/[\w]+\/status\/\d+/i, color: 0x000000 },
  { name: 'instagram', pattern: /instagram\.com\/(p|reel|reels|tv)\/[\w-]+/i, color: 0xc13584 },
  { name: 'tiktok', pattern: /tiktok\.com\/@[\w.-]+\/video\/\d+/i, color: 0xfe2c55, oembed: (u) => `https://www.tiktok.com/oembed?url=${encodeURIComponent(u)}` },
  { name: 'youtube', pattern: /(?:youtube\.com\/(?:watch|shorts|live)|youtu\.be\/)[\w-]+/i, color: 0xff0000, oembed: (u) => `https://www.youtube.com/oembed?url=${encodeURIComponent(u)}&format=json` },
  { name: 'reddit', pattern: /reddit\.com\/r\/[\w]+\/comments\/[\w]+/i, color: 0xff4500 },
  { name: 'facebook', pattern: /facebook\.com\/[\w.]+\/(posts|videos|watch)\/[\w.?=&%]+/i, color: 0x1877f2 },
  { name: 'threads', pattern: /threads\.(?:net|com)\/@[\w.]+\/post\/[\w-]+/i, color: 0x000000 },
  { name: 'spotify', pattern: /open\.spotify\.com\/(track|album|playlist|episode)\/[\w]+/i, color: 0x1db954, oembed: (u) => `https://open.spotify.com/oembed?url=${encodeURIComponent(u)}` },
  { name: 'soundcloud', pattern: /soundcloud\.com\/[\w-]+\/[\w-]+/i, color: 0xff5500, oembed: (u) => `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(u)}` },
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

function pick(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

async function fetchJson(url: string, timeoutMs = 8000): Promise<Record<string, unknown> | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; embed-converter/1.0)', accept: 'application/json' },
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function metaTag(html: string, key: string): string | undefined {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${key}["']`, 'i');
  const m = html.match(re) ?? html.match(re2);
  return m?.[1] ? decodeEntities(m[1]) : undefined;
}

async function fetchOpenGraph(url: string, timeoutMs = 8000): Promise<Partial<EmbedMeta> | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', accept: 'text/html' },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const title = metaTag(html, 'og:title') ?? metaTag(html, 'twitter:title');
    const description = metaTag(html, 'og:description') ?? metaTag(html, 'twitter:description') ?? metaTag(html, 'description');
    if (!title && !description) return null;
    return {
      title,
      description: description?.slice(0, 500),
      siteName: metaTag(html, 'og:site_name'),
      author: metaTag(html, 'og:title') ? undefined : undefined,
      image: metaTag(html, 'og:image') ?? metaTag(html, 'twitter:image'),
      video: metaTag(html, 'og:video:url') ?? metaTag(html, 'og:video') ?? metaTag(html, 'twitter:player'),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Fetch rich metadata for a social URL: oEmbed first, OpenGraph fallback. */
export async function fetchEmbedMeta(url: string): Promise<EmbedMeta | null> {
  const provider = detectProvider(url);
  const base: EmbedMeta = { provider: provider?.name ?? 'link', url, color: provider?.color };

  if (provider?.oembed) {
    const json = await fetchJson(provider.oembed(url));
    if (json) {
      const author = typeof json.author_name === 'string' ? json.author_name : undefined;
      const thumb = pick(json, 'thumbnail_url');
      return {
        ...base,
        title: pick(json, 'title'),
        description: typeof json.description === 'string' ? json.description : undefined,
        author,
        siteName: typeof json.provider_name === 'string' ? json.provider_name : provider.name,
        image: thumb,
        video: typeof json.html === 'string' && /<iframe|<video/i.test(json.html) ? url : undefined,
      };
    }
  }

  const og = await fetchOpenGraph(url);
  if (!og) return null;
  return { ...base, ...og };
}
