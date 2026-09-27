# Provenance — katgpt-magika-wasm (vendored WASM)

This directory holds a vendored wasm-bindgen build of **katgpt-magika-wasm** —
the WebAssembly packaging of katgpt's **pure-Rust `no_std` rewrite of Magika**.

**Not the official Google Magika.** Google's Magika
(<https://github.com/google/magika>) is a Python/ONNX deep-learning detector;
this artifact is an independent Rust reimplementation of its content-type
detection, compiled to WASM. Practical consequences recorded for honesty:

- detection labels/groups/extensions follow the rewrite's rule tables, which
  approximate — but are not byte-identical to — Google's model output;
- maishare only uses the result as a *hint*: `resolveMime` in
  `src/lib/magika.ts` keeps the browser-derived mime unless the sniff is
  confident, and `suspiciousMismatch` warns rather than blocks. A
  misclassification degrades a preview label, never file integrity (bytes are
  transferred and stored verbatim regardless of the sniff).

Why vendored: the runtime fetches the `.wasm` relative to the app origin
(`/vendor/katgpt-magika-wasm/…`, see `src/lib/magika.ts`) so content-type
sniffing works offline inside the installed PWA and behind the worker's asset
serving, without a bundler integration for the wasm-bindgen glue. Vendored as
part of the Magika integration commit (`feat(lib): integrate Magika for deep
content-type sniffing`); there is no npm dependency — these files ARE the
dependency.

## Build fingerprint

Rust standard library paths embedded in the `.wasm` carry the compiler commit
`48a229ceaefd4985c50990b14116b6d856af0985` (the rustc release the upstream
author built with).

## Files (SHA-256 at time of vendoring, 2026-09-26)

| File | SHA-256 |
| --- | --- |
| `katgpt_magika_wasm.d.ts` | `2bcc0435bf78ba6b3f77db0dd4b61ae1da52cce452ea816807d3839f6a324638` |
| `katgpt_magika_wasm.js` | `e4c11e7995bae7bbb3b7913556feea493db51f4fa521c1f675e7090dd3c410a3` |
| `katgpt_magika_wasm_bg.wasm` | `30c0b57defccb38a4c1f6134f5165423755fd371346c75abb615ed10ed247e35` |
| `katgpt_magika_wasm_bg.wasm.d.ts` | `6dcadac7aed3cb5c8317f53ca7ff61c434fb9c2ec08aa9ddc7b4f39677a076b2` |

Verify at any time: `sha256sum vendor/katgpt-magika-wasm/*` and compare against
`git log` for this directory — any change to the `.wasm` should be a reviewed
commit that updates this file.

## Update procedure

1. Build/download a new `katgpt-magika-wasm` wasm-bindgen package (from the
   katgpt rewrite's own releases — do not substitute Google's official model
   artifacts; the two are different implementations).
2. Replace the four files here; keep the loader path in `src/lib/magika.ts`
   pointing at this directory.
3. Re-hash every file and update the table above in the same commit.
4. `pnpm run typecheck && vp test && vp build && pnpm run test:e2e` — the
   magika unit suite asserts detection behavior, so a bad artifact fails fast.
