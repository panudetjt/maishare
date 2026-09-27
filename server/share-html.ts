// Social preview rewriting for SPA HTML navigations served through the
// worker. Kept free of Workers runtime imports so it unit-tests under plain
// vitest.

/** content hash injected at build time (vite `define`) — versioning the og
 * image URL busts chat-app preview caches whenever the image changes */
declare const __OG_ASSET_VERSION__: string;

/**
 * Rewrite social-preview meta of an HTML document for a room invite. The
 * home build already bakes absolute canonical og:image/twitter:image URLs
 * (vite `og-absolute-urls` plugin) — those are left untouched so previews
 * stay canonical and reachable from any deployment; only a still-relative
 * image is absolutized as a safety net. With a roomId the title/description
 * additionally name the room being joined. The invite key (`?k=`) never
 * appears in the markup — crawlers of chat apps must not learn it from the
 * preview metadata. Patterns tolerate whitespace/newlines between attributes
 * — the source HTML wraps long meta tags across lines.
 */
export function rewriteShareHtml(html: string, origin: string, roomId?: string): string {
  let out = html
    .replace(
      /<meta\s+property="og:image"\s+content="\/og\.png"/,
      `<meta property="og:image" content="${origin}/og.png?v=${__OG_ASSET_VERSION__}"`,
    )
    .replace(
      /<meta\s+name="twitter:image"\s+content="\/og\.png"/,
      `<meta name="twitter:image" content="${origin}/og.png?v=${__OG_ASSET_VERSION__}"`,
    );
  if (!roomId) return out;
  const roomTitle = `maishare room ${roomId}`;
  const roomDesc =
    "Open this invite to share files and text peer-to-peer — end-to-end encrypted, no cloud, no accounts.";
  return out
    .replace(/<title>.*?<\/title>/, `<title>${roomTitle}</title>`)
    .replace(
      /<meta\s+property="og:title"\s+content="[^"]*"/,
      `<meta property="og:title" content="${roomTitle}"`,
    )
    .replace(
      /<meta\s+property="og:description"\s+content="[^"]*"/,
      `<meta property="og:description" content="${roomDesc}"`,
    )
    .replace(
      /<meta\s+name="twitter:title"\s+content="[^"]*"/,
      `<meta name="twitter:title" content="${roomTitle}"`,
    )
    .replace(
      /<meta\s+name="twitter:description"\s+content="[^"]*"/,
      `<meta name="twitter:description" content="${roomDesc}"`,
    );
}
