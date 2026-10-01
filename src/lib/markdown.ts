// Rich rendering for text Magika identifies as markdown — the chat-bubble
// sibling of the code bubbles: headings, lists, tables, fenced code (via the
// same lazy highlight.js) and ```mermaid fences upgraded to real diagrams.
//
// Security model for peer-supplied markdown (this renders content a peer
// sent, so the renderer is the trust boundary):
//   - markdown-it runs with html:false — raw HTML is always escaped, so the
//     only markup in the output is what our own renderer rules emit
//   - markdown-it's validateLink drops javascript:/data: URLs (the syntax
//     renders as plain text instead of an anchor)
//   - images render as links — the CSP only allows self/data:/blob: images,
//     so a remote <img> would be a broken-icon noise generator
//   - mermaid runs at securityLevel 'strict' (its own sanitizer, no click
//     interactivity) and only loads when a bubble actually carries a fence
//
// Everything is lazy like highlight.ts: markdown-it and mermaid ship as
// separate chunks fetched on first use, and any load failure degrades to the
// plain text render.

import type { SniffInfo } from "./magika";
import { highlightWithGrammar } from "./highlight";

/** below this the sniff is a guess — stay plain text (mirrors highlight.ts) */
const MIN_MARKDOWN_SCORE = 0.5;
/** mermaid render is expensive — a bubble carries at most this many diagrams */
const MAX_DIAGRAMS = 4;
/** one fence beyond this many chars is treated as prose, not a diagram */
const MAX_DIAGRAM_CHARS = 20_000;

/** true when a text part should render as rich markdown */
export function isMarkdownText(info: SniffInfo | null | undefined): info is SniffInfo {
  return !!info && info.score >= MIN_MARKDOWN_SCORE && info.label === "markdown";
}

type MarkdownItInstance = import("markdown-it").MarkdownIt;
type MarkdownItOptions = import("markdown-it").MarkdownItOptions;
type MarkdownToken = import("markdown-it").Token;

let mdPromise: Promise<MarkdownItInstance | null> | null = null;

function loadMarkdownIt(): Promise<MarkdownItInstance | null> {
  mdPromise ??= import("markdown-it")
    .then((mod) => {
      // commonjs module — under vite's esm interop the class rides .default
      const Md = (
        mod as unknown as { default: new (options?: MarkdownItOptions) => MarkdownItInstance }
      ).default;
      const md = new Md({ html: false, linkify: true, breaks: true });
      // fences: mermaid becomes a placeholder the upgrade pass swaps for an
      // SVG; other languages stay plain until the same pass highlights them
      md.renderer.rules.fence = (tokens: MarkdownToken[], idx: number) => {
        const token = tokens[idx];
        const info = token.info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
        const code = md.utils.escapeHtml(token.content);
        if (info === "mermaid") return `<pre class="md-mermaid"><code>${code}</code></pre>`;
        const cls = /^[\w-]+$/.test(info) ? ` class="language-${info}"` : "";
        return `<pre><code${cls}>${code}</code></pre>`;
      };
      // images → links: see the security model above
      md.renderer.rules.image = (tokens: MarkdownToken[], idx: number) => {
        const token = tokens[idx];
        const href = String(token.attrGet("src") ?? "");
        const alt = md.utils.escapeHtml(token.content.trim());
        return `<a class="md-image-link" href="${md.utils.escapeHtml(href)}" target="_blank" rel="noopener noreferrer">🖼 ${alt || md.utils.escapeHtml(href)}</a>`;
      };
      return md;
    })
    .catch((err) => {
      console.warn("markdown-it unavailable — markdown renders as plain text", err);
      return null;
    });
  return mdPromise;
}

/** rendered markdown HTML, or null when the renderer could not be loaded */
export async function renderMarkdown(text: string): Promise<string | null> {
  const md = await loadMarkdownIt();
  if (!md) return null;
  return md.render(text);
}

type Mermaid = typeof import("mermaid").default;

let mermaidPromise: Promise<Mermaid | null> | null = null;
let mermaidSeq = 0;

function loadMermaid(): Promise<Mermaid | null> {
  mermaidPromise ??= import("mermaid")
    .then((m) => {
      const mermaid = m.default;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "dark",
      });
      return mermaid;
    })
    .catch((err) => {
      console.warn("mermaid unavailable — diagram fences stay as code", err);
      return null;
    });
  return mermaidPromise;
}

/**
 * Progressive upgrades over the rendered markdown DOM: highlight fenced code
 * with the lazy highlight.js and swap ```mermaid fences for rendered SVG
 * diagrams. Mutates the container in place — React owns the outer node's
 * innerHTML and never revisits its children, the same contract the code
 * bubbles' async swap relies on.
 */
export async function upgradeMarkdown(container: HTMLElement): Promise<void> {
  // every link opens in a new tab without granting it reference access
  for (const a of container.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  }
  // fenced code → highlighted (mermaid placeholders carry no language class)
  for (const code of container.querySelectorAll<HTMLElement>("pre > code[class^='language-']")) {
    const lang = [...code.classList]
      .find((c) => c.startsWith("language-"))
      ?.slice("language-".length);
    if (!lang) continue;
    const html = await highlightWithGrammar(code.textContent ?? "", lang);
    if (html) code.innerHTML = html;
  }
  // mermaid fences → rendered diagrams; a fence that fails to parse simply
  // stays as its code block
  if (!container.querySelector(".md-mermaid")) return;
  const mermaid = await loadMermaid();
  if (!mermaid) return;
  const fences = [...container.querySelectorAll(".md-mermaid")];
  for (const [i, fence] of fences.entries()) {
    if (i >= MAX_DIAGRAMS) break;
    const src = fence.textContent ?? "";
    if (!src || src.length > MAX_DIAGRAM_CHARS) continue;
    try {
      const { svg } = await mermaid.render(`md-mermaid-${++mermaidSeq}`, src);
      const holder = document.createElement("div");
      holder.className = "md-mermaid-svg";
      holder.innerHTML = svg;
      fence.replaceWith(holder);
    } catch (err) {
      console.warn("mermaid render failed — fence stays as code", err);
    }
  }
}
