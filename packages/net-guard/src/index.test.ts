import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { WebhookDestinationError, assertPublicWebhookUrl, isBlockedAddress } from "./index.js";

describe("isBlockedAddress — IPv4", () => {
  const blocked = [
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.1",
    "10.255.255.254",
    "100.64.0.1", // CGNAT
    "100.127.255.255",
    "127.0.0.1",
    "127.1.2.3",
    "169.254.169.254", // cloud metadata / link-local
    "169.254.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.0.2.5", // TEST-NET-1
    "192.88.99.1",
    "192.168.0.1",
    "192.168.1.1",
    "198.18.0.1", // benchmarking
    "198.51.100.1", // TEST-NET-2
    "203.0.113.1", // TEST-NET-3
    "224.0.0.1", // multicast
    "239.255.255.255",
    "240.0.0.1", // reserved
    "255.255.255.255",
  ];
  for (const ip of blocked) {
    it(`blocks ${ip}`, () => assert.equal(isBlockedAddress(ip), true));
  }

  const allowed = [
    "1.1.1.1",
    "8.8.8.8",
    "93.184.216.34", // example.com
    "172.15.255.255", // just below 172.16/12
    "172.32.0.1", // just above 172.16/12
    "100.63.255.255", // just below CGNAT
    "100.128.0.1", // just above CGNAT
    "11.0.0.1",
    "126.255.255.255", // just below 127/8
    "128.0.0.1", // just above 127/8
    "169.253.255.255", // just below link-local
    "169.255.0.1", // just above link-local
    "192.0.1.255", // just below 192.0.2/24
    "192.0.3.0", // just above 192.0.2/24
  ];
  for (const ip of allowed) {
    it(`allows ${ip}`, () => assert.equal(isBlockedAddress(ip), false));
  }
});

describe("isBlockedAddress — IPv6", () => {
  const blocked = [
    "::1", // loopback
    "::", // unspecified
    "fc00::1", // ULA
    "fd12:3456:789a::1", // ULA
    "fe80::1", // link-local
    "febf::1", // link-local upper edge
    "ff02::1", // multicast
    "2001:db8::1", // documentation
    "64:ff9b::a9fe:a9fe", // NAT64 wrapping 169.254.169.254
    "64:ff9b::7f00:1", // NAT64 wrapping 127.0.0.1
    "::ffff:127.0.0.1", // v4-mapped loopback
    "::ffff:169.254.169.254", // v4-mapped metadata
    "::ffff:10.0.0.1", // v4-mapped private
    "2001::1", // Teredo 2001::/32
    "2001:2::1", // benchmarking 2001:2::/48
    "2002:c0a8:0101::1", // 6to4 2002::/16 wrapping 192.168.1.1
    "3fff::1", // documentation 3fff::/20
    "3fff:0fff::1", // documentation 3fff::/20 upper edge
  ];
  for (const ip of blocked) {
    it(`blocks ${ip}`, () => assert.equal(isBlockedAddress(ip), true));
  }

  const allowed = [
    "2606:4700:4700::1111", // cloudflare dns
    "2001:4860:4860::8888", // google dns
    "2000::1", // low edge of global unicast
    "::ffff:8.8.8.8", // v4-mapped public
  ];
  for (const ip of allowed) {
    it(`allows ${ip}`, () => assert.equal(isBlockedAddress(ip), false));
  }

  it("blocks addresses outside global-unicast 2000::/3", () => {
    assert.equal(isBlockedAddress("4000::1"), true);
    assert.equal(isBlockedAddress("1000::1"), true);
  });

  it("blocks garbage that isn't an IP", () => {
    assert.equal(isBlockedAddress("not-an-ip"), true);
    assert.equal(isBlockedAddress(""), true);
  });
});

describe("assertPublicWebhookUrl", () => {
  const origEnv = process.env.WEBHOOK_ALLOW_PRIVATE_DESTINATIONS;
  afterEach(() => {
    process.env.WEBHOOK_ALLOW_PRIVATE_DESTINATIONS = origEnv ?? "";
  });

  async function rejects(url: string) {
    await assert.rejects(() => assertPublicWebhookUrl(url), WebhookDestinationError);
  }

  it("rejects non-http(s) schemes", async () => {
    await rejects("ftp://example.com/");
    await rejects("file:///etc/passwd");
    await rejects("gopher://example.com/");
  });

  it("rejects malformed urls", async () => {
    await rejects("not a url");
    await rejects("");
  });

  it("rejects embedded credentials", async () => {
    await rejects("http://user:pass@example.com/");
  });

  it("rejects literal private / loopback / metadata IPs", async () => {
    await rejects("http://127.0.0.1/");
    await rejects("http://169.254.169.254/latest/meta-data/");
    await rejects("http://10.0.0.5:8123/");
    await rejects("http://[::1]/");
    await rejects("http://[::ffff:127.0.0.1]/");
    await rejects("https://192.168.1.1/");
  });

  it("accepts a public literal IP", async () => {
    await assert.doesNotReject(() => assertPublicWebhookUrl("https://1.1.1.1/hook"));
  });

  it("still enforces scheme even with the private-destinations escape hatch on", async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE_DESTINATIONS = "1";
    await rejects("ftp://127.0.0.1/");
    // ...but a private literal is allowed once the hatch is open
    await assert.doesNotReject(() => assertPublicWebhookUrl("http://127.0.0.1:8080/"));
  });
});
