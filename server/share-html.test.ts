import { describe, expect, it } from "vite-plus/test";
import { rewriteShareHtml } from "./share-html";

// mirrors the head emitted by index.html after the og-absolute-urls build
// plugin bakes canonical absolute URLs into it — og:description is wrapped
// across lines by the source formatting, which the patterns must tolerate
const BAKED_HEAD = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="description" content="maishare — local-first, peer-to-peer sharing" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="maishare" />
    <meta property="og:url" content="https://maishare.panudetjt.workers.dev/" />
    <meta property="og:title" content="maishare — local-first p2p sharing" />
    <meta
      property="og:description"
      content="Share files and text peer-to-peer, end-to-end encrypted. No cloud, no accounts — data never leaves your network."
    />
    <meta property="og:image" content="https://maishare.panudetjt.workers.dev/og.png?v=0cbd38f8e283" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="maishare — local-first p2p sharing" />
    <meta
      name="twitter:description"
      content="Share files and text peer-to-peer, end-to-end encrypted. No cloud, no accounts — data never leaves your network."
    />
    <meta name="twitter:image" content="https://maishare.panudetjt.workers.dev/og.png?v=0cbd38f8e283" />
    <title>maishare — local-first p2p sharing</title>
  </head>
</html>`;

describe("rewriteShareHtml", () => {
  it("leaves canonical baked image URLs untouched on the home page", () => {
    const out = rewriteShareHtml(BAKED_HEAD, "https://lan.example");
    expect(out).toBe(BAKED_HEAD);
  });

  it("absolutizes a still-relative image as a safety net", () => {
    const relative = BAKED_HEAD.replace(
      /content="https:\/\/maishare\.panudetjt\.workers\.dev\/og\.png\?v=[0-9a-f]{12}"/g,
      'content="/og.png"',
    );
    const out = rewriteShareHtml(relative, "https://lan.example");
    expect(out.match(/content="https:\/\/lan\.example\/og\.png\?v=[0-9a-f]{12}"/g)?.length).toBe(2);
    expect(out).not.toContain('content="/og.png"');
  });

  it("names the room in the title and og/twitter metadata", () => {
    const out = rewriteShareHtml(BAKED_HEAD, "https://share.example", "k7m2xq");
    expect(out).toContain("<title>maishare room k7m2xq</title>");
    expect(out).toContain('property="og:title" content="maishare room k7m2xq"');
    expect(out).toContain('name="twitter:title" content="maishare room k7m2xq"');
  });

  it("rewrites the wrapped multi-line description metas for invites", () => {
    const out = rewriteShareHtml(BAKED_HEAD, "https://share.example", "k7m2xq");
    expect(out.match(/og:description" content="[^"]*"/g)).toEqual([
      'og:description" content="Open this invite to share files and text peer-to-peer — end-to-end encrypted, no cloud, no accounts."',
    ]);
    expect(out).not.toContain("data never leaves your network");
  });

  it("keeps canonical image and og:url stable across rooms", () => {
    const out = rewriteShareHtml(BAKED_HEAD, "https://lan.example", "k7m2xq");
    expect(out.match(/og\.png\?v=0cbd38f8e283/g)?.length).toBe(2);
    expect(out).toContain('property="og:url" content="https://maishare.panudetjt.workers.dev/"');
  });

  it("leaves everything but the preview metadata untouched", () => {
    const out = rewriteShareHtml(BAKED_HEAD, "https://share.example", "k7m2xq");
    expect(out).toContain(
      '<meta name="description" content="maishare — local-first, peer-to-peer sharing" />',
    );
    expect(out).toContain('property="og:type" content="website"');
    expect(out).toContain('name="twitter:card" content="summary_large_image"');
  });
});
