import dns from "node:dns";

// Bypass Railway's in-container resolver, which returns stale/mis-routed
// answers for api.anthropic.com that land on CF anycast IPs not
// authorized for Anthropic's zone — Cloudflare then rejects the TLS
// handshake with Error 1000 ("DNS points to prohibited IP"). Pinning the
// resolver to Cloudflare + Google fixes the A record, and the lookup
// patch below forces IPv4 so undici can't prefer an AAAA with the same
// problem.
dns.setServers(["1.1.1.1", "8.8.8.8"]);

// Prefer IPv4 via c-ares `resolve4` over getaddrinfo. Also matters on local
// networks where getaddrinfo returns AAAA-only for hosts with no global v6 route.
// biome-ignore lint/suspicious/noExplicitAny: matches Node's overloaded lookup signature
const origLookup = dns.lookup as any;

// biome-ignore lint/suspicious/noExplicitAny: matches Node's overloaded lookup signature
(dns as any).lookup = function patchedLookup(
  hostname: string,
  optsOrCb: unknown,
  maybeCb?: unknown,
) {
  const cb = (typeof optsOrCb === "function" ? optsOrCb : maybeCb) as (
    err: NodeJS.ErrnoException | null,
    address?: string | { address: string; family: number }[],
    family?: number,
  ) => void;
  const opts = (typeof optsOrCb === "function" ? {} : optsOrCb) as {
    all?: boolean;
    family?: number;
  };

  if (opts.family === 6) {
    return origLookup(hostname, opts, cb);
  }

  dns.resolve4(hostname, (err, addrs) => {
    if (!err && addrs?.length) {
      if (opts.all) {
        return cb(
          null,
          addrs.map((a) => ({ address: a, family: 4 })),
        );
      }
      return cb(null, addrs[0], 4);
    }
    origLookup(hostname, opts, cb);
  });
};
