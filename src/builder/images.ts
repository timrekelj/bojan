// Downloads Discord image attachments so they can be sent to the model as real image inputs.
import type { Message } from 'discord.js';
import { MAX_IMAGE_BYTES, MAX_IMAGES, selectImages, type AttachmentInfo, type PromptImage } from './chat-parse.js';

const DOWNLOAD_TIMEOUT_MS = 20_000;

/** Plain attachment data of a message (for `selectImages`). */
export function attachmentInfos(message: Message): AttachmentInfo[] {
  return [...message.attachments.values()].map((a) => ({ name: a.name ?? null, url: a.url, contentType: a.contentType ?? null, size: a.size }));
}

/** Image attachments of the messages (in order, at most MAX_IMAGES in total) as data URIs. A failed download is logged and skipped. */
export async function downloadImages(messages: readonly Message[], tag: 'chat' | 'builder'): Promise<PromptImage[]> {
  const refs = selectImages(messages.flatMap(attachmentInfos), MAX_IMAGES);
  const results = await Promise.all(
    refs.map(async (ref): Promise<PromptImage | null> => {
      try {
        const res = await fetch(ref.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.length > MAX_IMAGE_BYTES) throw new Error('too large');
        return { uri: `data:${ref.mime};base64,${bytes.toString('base64')}`, source: { type: 'inline' }, name: ref.name };
      } catch (err) {
        console.warn(`[${tag}] could not download image ${ref.name}:`, err instanceof Error ? err.message : err);
        return null;
      }
    }),
  );
  return results.filter((r): r is PromptImage => r !== null);
}
