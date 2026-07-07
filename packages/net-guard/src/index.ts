import { lookup } from "node:dns";
import { isIP } from "node:net";
import { Agent, type Dispatcher, fetch as undiciFetch } from "undici";

// Guards outbound webhook delivery against SSRF. The destination host is
// resolved and every resolved address is checked against a default-deny set of
// non-public ranges (RFC1918, loopback, link-local / cloud-metadata, CGNAT,
// ULA, multicast, reserved, documentation). The connection is then pinned to a
// validated address so a second DNS answer can't rebind us onto an internal
// host between the check and the connect.
//
// An operator escape hatch (WEBHOOK_ALLOW_PRIVATE_DESTINATIONS=1) exists for
// local dev and self-hosters who deliberately point webhooks at private
// infrastructure. It is off by default; scheme/credential checks still apply.

export class WebhookDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookDestinationError";
  }
}

function allowPrivateDestinations(): boolean {
  const v = process.env.WEBHOOK_ALLOW_PRIVATE_DESTINATIONS;
  return v === "1" || v === "true";
}

// --- IPv4 ---------------------------------------------------------------

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

// [network, prefix-bits]
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // RFC1918
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local + cloud metadata (169.254.169.254)
  ["172.16.0.0", 12], // RFC1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // RFC1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved (covers 255.255.255.255)
];

function inCidr4(ip: number, network: string, bits: number): boolean {
  const base = ipv4ToInt(network);
  if (base === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) >>> 0 === (base & mask) >>> 0;
}

export function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable → fail closed
  return BLOCKED_V4.some(([net, bits]) => inCidr4(n, net, bits));
}

// --- IPv6 ---------------------------------------------------------------

// Parse into 8 16-bit groups, or null if malformed. Handles "::" compression,
// zone ids, and embedded IPv4 (e.g. ::ffff:1.2.3.4).
function parseIpv6(input: string): number[] | null {
  let s = input;
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (s.length === 0) return null;

  let ipv4Tail: [number, number] | null = null;
  if (s.includes(".")) {
    const colon = s.lastIndexOf(":");
    if (colon < 0) return null;
    const v4 = ipv4ToInt(s.slice(colon + 1));
    if (v4 === null) return null;
    ipv4Tail = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    s = s.slice(0, colon);
  }

  const hextet = (h: string): number | null => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(h)) return null;
    return Number.parseInt(h, 16);
  };
  const parseGroups = (str: string): number[] | null => {
    if (str === "") return [];
    const out: number[] = [];
    for (const g of str.split(":")) {
      const n = hextet(g);
      if (n === null) return null;
      out.push(n);
    }
    return out;
  };

  const dc = s.indexOf("::");
  let groups: number[];
  if (dc >= 0) {
    if (s.indexOf("::", dc + 2) >= 0) return null; // only one "::" allowed
    const head = parseGroups(s.slice(0, dc));
    const tail = parseGroups(s.slice(dc + 2));
    if (head === null || tail === null) return null;
    const explicit = head.length + tail.length + (ipv4Tail ? 2 : 0);
    const zeros = 8 - explicit;
    if (zeros < 1) return null; // "::" must cover at least one group
    groups = [...head, ...new Array(zeros).fill(0), ...tail, ...(ipv4Tail ?? [])];
  } else {
    const head = parseGroups(s);
    if (head === null) return null;
    groups = [...head, ...(ipv4Tail ?? [])];
  }
  if (groups.length !== 8) return null;
  return groups;
}

function groupsToEmbeddedV4(g: number[]): string {
  const hi = g[6] ?? 0;
  const lo = g[7] ?? 0;
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

export function isBlockedIpv6(ip: string): boolean {
  const g = parseIpv6(ip);
  if (!g) return true; // unparseable → fail closed

  // IPv4-mapped ::ffff:a.b.c.d — validate the embedded v4.
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return isBlockedIpv4(groupsToEmbeddedV4(g));
  }
  // NAT64 64:ff9b::/96 — validate the embedded v4.
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    return isBlockedIpv4(groupsToEmbeddedV4(g));
  }
  // :: (unspecified) and ::1 (loopback)
  if (g.slice(0, 7).every((x) => x === 0) && (g[7] === 0 || g[7] === 1)) return true;

  const first = g[0] ?? 0;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (first === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 documentation

  // Default-deny: only allow global-unicast 2000::/3.
  if ((first & 0xe000) !== 0x2000) return true;
  return false;
}

// --- public API ---------------------------------------------------------

export function isBlockedAddress(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return isBlockedIpv4(ip);
  if (fam === 6) return isBlockedIpv6(ip);
  return true; // not a bare IP → fail closed
}

function lookupAll(host: string): Promise<{ address: string; family: number }[]> {
  return new Promise((resolve, reject) => {
    lookup(host, { all: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });
}

// Validate scheme/credentials and — unless the escape hatch is on — resolve the
// host and reject if any resolved address is non-public. Throws
// WebhookDestinationError on any violation. Used for fail-fast validation when a
// webhook is created/updated; the delivery dispatcher re-validates and pins.
export async function assertPublicWebhookUrl(raw: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new WebhookDestinationError("url must be a valid http(s) URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new WebhookDestinationError("url must use http or https");
  }
  if (u.username !== "" || u.password !== "") {
    throw new WebhookDestinationError("url must not contain credentials");
  }
  if (allowPrivateDestinations()) return;

  const host = u.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new WebhookDestinationError("destination address is not allowed");
    }
    return;
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookupAll(host);
  } catch {
    throw new WebhookDestinationError("could not resolve destination host");
  }
  if (addresses.length === 0) {
    throw new WebhookDestinationError("could not resolve destination host");
  }
  for (const a of addresses) {
    if (isBlockedAddress(a.address)) {
      throw new WebhookDestinationError("destination resolves to a disallowed address");
    }
  }
}

let dispatcher: Agent | null = null;

// undici Agent whose connect step resolves the host, rejects if ANY resolved
// address is non-public, then pins the connection to a validated address (so a
// rebinding second answer can't slip through between validation and connect).
function guardedDispatcher(): Agent {
  if (dispatcher) return dispatcher;
  dispatcher = new Agent({
    connect: {
      // biome-ignore lint/suspicious/noExplicitAny: matches Node's overloaded lookup signature
      lookup(hostname: string, options: any, callback: any) {
        if (allowPrivateDestinations()) {
          lookup(hostname, options, callback);
          return;
        }
        lookup(hostname, { ...options, all: true }, (err, addresses) => {
          if (err) return callback(err, undefined, undefined);
          const list = addresses as unknown as { address: string; family: number }[];
          for (const a of list) {
            if (isBlockedAddress(a.address)) {
              return callback(new WebhookDestinationError("destination address is not allowed"));
            }
          }
          const chosen = list[0];
          if (!chosen) {
            return callback(new WebhookDestinationError("could not resolve destination host"));
          }
          if (options?.all) return callback(null, list);
          callback(null, chosen.address, chosen.family);
        });
      },
    },
  });
  return dispatcher;
}

export type WebhookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

// Deliver a webhook request through the SSRF-guarded, IP-pinned dispatcher.
// Validates the destination up front (undici skips connect.lookup for literal
// IPs, so a literal private IP would otherwise slip past the dispatcher check),
// then re-validates and pins in the dispatcher for the hostname case. Redirects
// are never followed — a 3xx is returned as-is (and treated as a non-2xx
// failure by the caller) so a redirect can't bounce us to an internal host.
export async function webhookFetch(url: string, init: WebhookFetchInit): Promise<Response> {
  await assertPublicWebhookUrl(url);
  const res = await undiciFetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
    redirect: "manual",
    dispatcher: guardedDispatcher() as Dispatcher,
  });
  return res as unknown as Response;
}
