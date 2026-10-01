// Unit tests for the markdown bubble renderer. Focus: the trust boundary for
// peer-supplied markdown (raw HTML escaped, dangerous links dropped, images
// demoted to links) plus the fence placeholders the DOM upgrade pass swaps
// for highlighted code and mermaid diagrams. DOM-dependent upgrades run in
// the browser only.
import { describe, expect, it } from "vite-plus/test";
import { isMarkdownText, renderMarkdown } from "./markdown";
import type { SniffInfo } from "./magika";

function info(partial: Partial<SniffInfo>): SniffInfo {
  return {
    label: "markdown",
    mime: "text/markdown",
    group: "text",
    description: "Markdown",
    extensions: ["md", "markdown"],
    score: 0.97,
    isText: true,
    ...partial,
  };
}

describe("isMarkdownText", () => {
  it("accepts confident markdown sniffs only", () => {
    expect(isMarkdownText(info({}))).toBe(true);
    expect(isMarkdownText(info({ score: 0.5 }))).toBe(true);
    expect(isMarkdownText(info({ score: 0.49 }))).toBe(false);
    expect(isMarkdownText(info({ label: "txt", mime: "text/plain" }))).toBe(false);
    expect(isMarkdownText(info({ label: "python", group: "code" }))).toBe(false);
    expect(isMarkdownText(null)).toBe(false);
    expect(isMarkdownText(undefined)).toBe(false);
  });
});

describe("renderMarkdown", () => {
  it("renders structure: headings, lists, tables, emphasis", async () => {
    const html = (await renderMarkdown(
      "# Plan\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\ncall **now**",
    ))!;
    expect(html).toContain("<h1>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<table>");
    expect(html).toContain("<strong>now</strong>");
  });

  it("always escapes raw HTML from peers", async () => {
    const html = (await renderMarkdown(
      "hello <img src=x onerror=alert(1)> <script>alert(2)</script>",
    ))!;
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
  });

  it("drops javascript: and data: link targets", async () => {
    const html = (await renderMarkdown(
      "[click](javascript:alert(1)) and [x](data:text/html;base64,PHNjcmlwdD4=)",
    ))!;
    expect(html).not.toContain('href="javascript');
    expect(html).not.toContain('href="data:');
  });

  it("renders images as links — the CSP allows no remote images", async () => {
    const html = (await renderMarkdown("![diagram](https://evil.example/x.png)"))!;
    expect(html).not.toContain("<img");
    expect(html).toContain('class="md-image-link"');
    expect(html).toContain('href="https://evil.example/x.png"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("emits language classes on fences and a placeholder for mermaid", async () => {
    const html = (await renderMarkdown(
      "```python\nprint(1)\n```\n\n```mermaid\ngraph TD\nA-->B\n```",
    ))!;
    expect(html).toContain('class="language-python"');
    expect(html).toContain('class="md-mermaid"');
    expect(html).toContain("graph TD");
  });

  it("escapes fence content so code cannot break out of the block", async () => {
    const html = (await renderMarkdown("```\n</pre><script>alert(1)</script>\n```"))!;
    expect(html).not.toContain("</pre><script>");
    expect(html).toContain("&lt;/pre&gt;");
  });
});
