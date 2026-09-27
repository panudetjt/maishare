import { describe, expect, it } from "vite-plus/test";
import { provableLan, sameLan } from "./lan";

describe("sameLan", () => {
  it("matches identical addresses", () => {
    expect(sameLan("192.168.1.10", "192.168.1.10")).toBe(true);
    expect(sameLan("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(sameLan("::1", "::1")).toBe(true);
    expect(sameLan("local", "local")).toBe(true);
    expect(sameLan("8.8.8.8", "8.8.8.8")).toBe(true);
  });

  it("matches private IPv4 hosts inside one /24", () => {
    expect(sameLan("192.168.1.10", "192.168.1.44")).toBe(true);
    expect(sameLan("10.0.0.1", "10.0.0.254")).toBe(true);
  });

  it("never matches distinct public IPv4 addresses (CGNAT safety)", () => {
    expect(sameLan("8.8.8.8", "8.8.8.9")).toBe(false);
    expect(sameLan("203.0.113.7", "203.0.113.7")).toBe(true);
    expect(sameLan("192.168.1.10", "8.8.8.8")).toBe(false);
  });

  it("splits private IPv4 networks at the /24 boundary", () => {
    expect(sameLan("192.168.1.10", "192.168.2.10")).toBe(false);
    expect(sameLan("10.0.0.1", "10.0.255.1")).toBe(false);
  });

  it("matches the same IPv6 /64", () => {
    expect(sameLan("2001:db8:1:2::15", "2001:db8:1:2::dead")).toBe(true);
    expect(sameLan("2001:0db8:0001:0002:0:0:0:1", "2001:db8:1:2::ff")).toBe(true);
  });

  it("keeps different IPv6 /64s apart", () => {
    expect(sameLan("2001:db8:1:2::15", "2001:db8:1:3::15")).toBe(false);
    expect(sameLan("fe80::1", "2001:db8::1")).toBe(false);
  });

  it("understands v4-mapped IPv6 addresses", () => {
    expect(sameLan("192.168.1.10", "::ffff:192.168.1.99")).toBe(true);
    expect(sameLan("192.168.1.10", "::FFFF:192.168.1.99")).toBe(true);
    expect(sameLan("192.168.1.10", "::ffff:192.168.9.99")).toBe(false);
    expect(sameLan("8.8.8.8", "::ffff:8.8.8.9")).toBe(false);
  });

  it("rejects garbage and empty input", () => {
    expect(sameLan("192.168.1.10", "banana")).toBe(false);
    expect(sameLan("", "192.168.1.10")).toBe(false);
    expect(sameLan("300.1.1.1", "192.168.1.10")).toBe(false);
    expect(sameLan("192.168.1.10", "1:2:3:4:5:6:7:8:9")).toBe(false);
  });
});

describe("provableLan (SEC-07)", () => {
  it("proves private IPv4 hosts in one /24", () => {
    expect(provableLan("192.168.1.10", "192.168.1.44")).toBe(true);
    expect(provableLan("10.0.0.1", "10.0.0.254")).toBe(true);
    expect(provableLan("127.0.0.1", "127.0.0.99")).toBe(true); // loopback range
  });

  it("proves v4-mapped equality over private ranges", () => {
    expect(provableLan("192.168.1.10", "::ffff:192.168.1.99")).toBe(true);
    expect(provableLan("192.168.1.10", "::FFFF:192.168.1.99")).toBe(true);
  });

  it("proves one IPv6 /64", () => {
    expect(provableLan("2001:db8:1:2::15", "2001:db8:1:2::dead")).toBe(true);
    expect(provableLan("fe80::1", "fe80::2")).toBe(true);
  });

  it("proves the loopback dev marker by equality", () => {
    expect(provableLan("local", "local")).toBe(true);
  });

  it("never proves a bare public-IPv4 match (CGNAT: it proves nothing)", () => {
    // the exact-equality case the old matcher accepted as a candidate
    expect(provableLan("203.0.113.7", "203.0.113.7")).toBe(false);
    expect(provableLan("8.8.8.8", "8.8.8.8")).toBe(false);
    // public equality in v4-mapped disguise is equally unprovable
    expect(provableLan("8.8.8.8", "::ffff:8.8.8.8")).toBe(false);
    expect(provableLan("8.8.8.8", "::ffff:8.8.8.9")).toBe(false);
  });

  it("keeps the matcher's other separations intact", () => {
    expect(provableLan("192.168.1.10", "192.168.2.10")).toBe(false); // /24 split
    expect(provableLan("2001:db8:1:2::15", "2001:db8:1:3::15")).toBe(false);
    expect(provableLan("192.168.1.10", "8.8.8.8")).toBe(false);
    expect(provableLan("", "192.168.1.10")).toBe(false);
    expect(provableLan("banana", "banana")).toBe(false); // garbage is not identity
    expect(provableLan("local", "127.0.0.1")).toBe(false);
  });
});
