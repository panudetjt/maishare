// Syntax highlighting for text detected as code — the second life of the
// Magika sniff: a pasted snippet identified as python/json/shell/… renders
// with highlight.js colors instead of the plain text line.
//
// Everything here is lazy: the hljs core and each grammar load as separate
// chunks the first time a code bubble actually renders, and any failure
// degrades to the plain monospace render (same philosophy as magika.ts).

import type { HLJSApi, LanguageFn } from "highlight.js";
import type { SniffInfo } from "./magika";

/** magika label → highlight.js grammar id (labels this wasm build emits) */
const GRAMMARS: Record<string, string> = {
  python: "python",
  javascript: "javascript",
  typescript: "typescript",
  json: "json",
  jsonl: "json", // this build reads JSON objects as jsonl (json-lines)
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  css: "css",
  html: "xml",
  twig: "twig", // and larger HTML as twig (a template superset of it)
  xml: "xml",
  sql: "sql",
  shell: "bash",
  bash: "bash",
  rust: "rust",
  go: "go",
  c: "c",
  cpp: "cpp",
  cs: "csharp",
  java: "java",
  kotlin: "kotlin",
  ruby: "ruby",
  php: "php",
  swift: "swift",
  lua: "lua",
  perl: "perl",
  r: "r",
  scala: "scala",
  haskell: "haskell",
  powershell: "powershell",
  asm: "x86asm",
  dockerfile: "dockerfile",
  markdown: "markdown",
  diff: "diff",
};

/** text-group labels that are still structured enough for a code render */
const STRUCTURED_TEXT = new Set(["toml", "ini", "markdown", "diff"]);

/** below this the sniff is a guess, not a fact — stay plain text (mirrors
 * magika.ts's own MIN_SCORE) */
const MIN_CODE_SCORE = 0.5;
/** highlighting beyond this costs more main-thread time than it is worth —
 * oversized pastes keep the plain monospace render */
const MAX_HIGHLIGHT_CHARS = 100_000;

/**
 * The highlight.js grammar id for detected text, or null when it should stay
 * plain: no info, weak confidence, and ordinary prose all return null.
 */
export function codeLanguage(info: SniffInfo | null | undefined): string | null {
  if (!info || info.score < MIN_CODE_SCORE) return null;
  const code = info.group === "code" || STRUCTURED_TEXT.has(info.label);
  return code ? (GRAMMARS[info.label] ?? null) : null;
}

/** true when a text part should render as a highlighted code block */
export function isCodeText(info: SniffInfo | null | undefined): info is SniffInfo {
  return codeLanguage(info) !== null;
}

type Hljs = HLJSApi;

let core: Promise<Hljs | null> | null = null;
const loaded = new Set<string>();

function loadCore(): Promise<Hljs | null> {
  core ??= import("highlight.js/lib/core")
    .then((m) => m.default)
    .catch((err) => {
      console.warn("highlight.js unavailable — code renders as plain text", err);
      return null;
    });
  return core;
}

/** explicit loaders keep unmapped grammars out of the build entirely */
const LOADERS: Record<string, () => Promise<{ default: LanguageFn }>> = {
  python: () => import("highlight.js/lib/languages/python"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  json: () => import("highlight.js/lib/languages/json"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
  ini: () => import("highlight.js/lib/languages/ini"),
  css: () => import("highlight.js/lib/languages/css"),
  twig: () => import("highlight.js/lib/languages/twig"),
  xml: () => import("highlight.js/lib/languages/xml"),
  sql: () => import("highlight.js/lib/languages/sql"),
  bash: () => import("highlight.js/lib/languages/bash"),
  rust: () => import("highlight.js/lib/languages/rust"),
  go: () => import("highlight.js/lib/languages/go"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  java: () => import("highlight.js/lib/languages/java"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  php: () => import("highlight.js/lib/languages/php"),
  swift: () => import("highlight.js/lib/languages/swift"),
  lua: () => import("highlight.js/lib/languages/lua"),
  perl: () => import("highlight.js/lib/languages/perl"),
  r: () => import("highlight.js/lib/languages/r"),
  scala: () => import("highlight.js/lib/languages/scala"),
  haskell: () => import("highlight.js/lib/languages/haskell"),
  powershell: () => import("highlight.js/lib/languages/powershell"),
  x86asm: () => import("highlight.js/lib/languages/x86asm"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  diff: () => import("highlight.js/lib/languages/diff"),
};

async function prepare(lang: string): Promise<Hljs | null> {
  const hljs = await loadCore();
  if (!hljs) return null;
  if (!loaded.has(lang)) {
    const loader = LOADERS[lang];
    if (!loader) return null;
    hljs.registerLanguage(lang, (await loader()).default);
    loaded.add(lang);
  }
  return hljs;
}

/**
 * Highlighted HTML for detected code text, or null to keep the plain render
 * (no grammar, oversized input, or a failed load). The returned string is
 * hljs-escaped — safe to inject via dangerouslySetInnerHTML.
 */
export async function highlightCode(text: string, info: SniffInfo): Promise<string | null> {
  const lang = codeLanguage(info);
  if (!lang || text.length > MAX_HIGHLIGHT_CHARS) return null;
  try {
    const hljs = await prepare(lang);
    if (!hljs) return null;
    return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch (err) {
    console.warn(`code highlight failed for ${lang} — rendering plain`, err);
    return null;
  }
}
