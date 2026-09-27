import { describe, expect, it } from "vite-plus/test";
import { isIOSPlatform, isStandaloneDisplay, shouldOfferInstall } from "./install";

const UA = {
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
  // iPadOS 13+ ships the desktop Safari UA — only maxTouchPoints gives it away
  ipadosDesktop:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  android:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
};

describe("isIOSPlatform", () => {
  it("detects iPhone, iPod and iPad UAs", () => {
    expect(isIOSPlatform(UA.iphone)).toBe(true);
    expect(isIOSPlatform(UA.ipad)).toBe(true);
  });

  it("detects iPadOS 13+ posing as desktop Safari via touch points", () => {
    expect(isIOSPlatform(UA.ipadosDesktop, 5)).toBe(true);
    expect(isIOSPlatform(UA.ipadosDesktop, 0)).toBe(false);
  });

  it("ignores desktop and Android UAs", () => {
    expect(isIOSPlatform(UA.windows, 0)).toBe(false);
    expect(isIOSPlatform(UA.android, 5)).toBe(false);
  });
});

describe("isStandaloneDisplay", () => {
  it("treats installed display modes as standalone", () => {
    expect(isStandaloneDisplay("standalone")).toBe(true);
    expect(isStandaloneDisplay("fullscreen")).toBe(true);
    expect(isStandaloneDisplay("minimal-ui")).toBe(true);
  });

  it("treats a normal tab as not standalone", () => {
    expect(isStandaloneDisplay("browser")).toBe(false);
  });

  it("honors the iOS home-screen flag even in browser mode", () => {
    expect(isStandaloneDisplay("browser", true)).toBe(true);
  });
});

describe("shouldOfferInstall", () => {
  it("offers the native prompt when captured", () => {
    expect(shouldOfferInstall({ canPrompt: true, installed: false, ios: false })).toBe(true);
  });

  it("offers the manual steps on iOS even without a prompt", () => {
    expect(shouldOfferInstall({ canPrompt: false, installed: false, ios: true })).toBe(true);
  });

  it("stays silent once installed", () => {
    expect(shouldOfferInstall({ canPrompt: true, installed: true, ios: true })).toBe(false);
  });

  it("stays silent on browsers with no install path", () => {
    expect(shouldOfferInstall({ canPrompt: false, installed: false, ios: false })).toBe(false);
  });
});
