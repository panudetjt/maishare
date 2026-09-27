// Ticket 10 / SECURITY-SPEC.md SEC-10 — config-default assertion: dev/preview
// servers bind localhost; exposing the worker (and its forwarded-header
// identity trust) to the LAN is the explicit --host opt-in the README
// documents, never a silent config default.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

describe("dev/preview binding default (SEC-10)", () => {
  it("dev/preview servers bind localhost by default (no server.host override)", () => {
    const cfg = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
    expect(cfg).not.toMatch(/host:\s*true/);
  });
});
