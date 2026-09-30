// Unit tests for the magika-label → highlight.js mapping and the lazy
// highlighter. The mapping pins labels the vendored Magika wasm actually
// emits for code text (verified against the real model in magika.test.ts).
import { describe, expect, it } from "vite-plus/test";
import { codeLanguage, highlightCode, isCodeText } from "./highlight";
import type { SniffInfo } from "./magika";

function info(partial: Partial<SniffInfo>): SniffInfo {
  return {
    label: "python",
    mime: "text/x-python",
    group: "code",
    description: "Python",
    extensions: ["py"],
    score: 1,
    isText: true,
    ...partial,
  };
}

describe("codeLanguage", () => {
  it("maps the labels this magika build emits to hljs grammars", () => {
    expect(codeLanguage(info({ label: "python" }))).toBe("python");
    expect(codeLanguage(info({ label: "typescript" }))).toBe("typescript");
    expect(codeLanguage(info({ label: "jsonl" }))).toBe("json");
    expect(codeLanguage(info({ label: "shell" }))).toBe("bash");
    expect(codeLanguage(info({ label: "cs" }))).toBe("csharp");
    expect(codeLanguage(info({ label: "asm" }))).toBe("x86asm");
    expect(codeLanguage(info({ label: "twig" }))).toBe("twig");
  });

  it("maps structured text-group labels too", () => {
    expect(codeLanguage(info({ label: "toml", group: "text", mime: "application/toml" }))).toBe(
      "ini",
    );
    expect(codeLanguage(info({ label: "diff", group: "text" }))).toBe("diff");
    expect(codeLanguage(info({ label: "markdown", group: "text" }))).toBe("markdown");
  });

  it("returns null for prose, unknown labels, and missing info", () => {
    expect(codeLanguage(info({ label: "txt", group: "text", mime: "text/plain" }))).toBeNull();
    expect(codeLanguage(info({ label: "csv", group: "text" }))).toBeNull();
    expect(codeLanguage(info({ label: "brainfuck", group: "code" }))).toBeNull();
    expect(codeLanguage(info({ label: "unknown", group: "unknown" }))).toBeNull();
    expect(codeLanguage(null)).toBeNull();
    expect(codeLanguage(undefined)).toBeNull();
  });

  it("stays plain on a low-confidence guess", () => {
    expect(codeLanguage(info({ score: 0.49 }))).toBeNull();
    expect(codeLanguage(info({ score: 0.5 }))).toBe("python");
  });
});

describe("isCodeText", () => {
  it("accepts code and structured text, rejects prose and weak sniffs", () => {
    expect(isCodeText(info({}))).toBe(true);
    expect(isCodeText(info({ label: "yaml" }))).toBe(true);
    expect(isCodeText(info({ label: "txt", group: "text" }))).toBe(false);
    expect(isCodeText(info({ score: 0.3 }))).toBe(false);
    expect(isCodeText(null)).toBe(false);
  });
});

describe("highlightCode", () => {
  it("returns hljs-escaped HTML with token spans for a real grammar", async () => {
    const html = await highlightCode('def main(name):\n    print(f"hi {name}")\n', info({}));
    expect(html).toContain('class="hljs-keyword"');
    // the text itself is escaped, never raw HTML from the source
    expect(html).not.toContain("<script");
  });

  it("escapes HTML-looking code so it renders as text", async () => {
    const html = await highlightCode(
      'const s = "<img src=x onerror=alert(1)>";\n',
      info({ label: "javascript", mime: "application/javascript" }),
    );
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img src=x");
  });

  it("returns null when there is no grammar or the input is oversized", async () => {
    expect(await highlightCode("x = 1\n", info({ label: "csv", group: "text" }))).toBeNull();
    expect(await highlightCode("x = 1\n", info({ score: 0.2 }))).toBeNull();
    const huge = "x = 1\n".repeat(20_000);
    expect(await highlightCode(huge, info({}))).toBeNull();
  });
});
