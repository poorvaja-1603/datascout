import { promises as dnsPromises } from 'node:dns';
import { isIP } from 'node:net';

export class SsrfError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SsrfError';
  }
}

export function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true;
  }

  const [p0 = 0, p1 = 0] = parts;

  // 0.0.0.0/8 (current network)
  if (p0 === 0) return true;
  // 10.0.0.0/8 (private)
  if (p0 === 10) return true;
  // 100.64.0.0/10 (carrier-grade NAT)
  if (p0 === 100 && p1 >= 64 && p1 <= 127) return true;
  // 127.0.0.0/8 (loopback)
  if (p0 === 127) return true;
  // 169.254.0.0/16 (link-local, cloud metadata service 169.254.169.254)
  if (p0 === 169 && p1 === 254) return true;
  // 172.16.0.0/12 (private)
  if (p0 === 172 && p1 >= 16 && p1 <= 31) return true;
  // 192.0.0.0/24 (IETF protocol assignments)
  if (p0 === 192 && p1 === 0 && parts[2] === 0) return true;
  // 192.0.2.0/24 (TEST-NET-1)
  if (p0 === 192 && p1 === 0 && parts[2] === 2) return true;
  // 192.168.0.0/16 (private)
  if (p0 === 192 && p1 === 168) return true;
  // 198.51.100.0/24 (TEST-NET-2)
  if (p0 === 198 && p1 === 51 && parts[2] === 100) return true;
  // 203.0.113.0/24 (TEST-NET-3)
  if (p0 === 203 && p1 === 0 && parts[2] === 113) return true;
  // 224.0.0.0/4 (multicast)
  if (p0 >= 224 && p0 <= 239) return true;
  // 240.0.0.0/4 (reserved / broadcast)
  if (p0 >= 240) return true;

  return false;
}

export function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();

  // ::1 loopback
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  // :: unspecified
  if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return true;

  // IPv4-mapped IPv6 (::ffff:192.168.1.1)
  if (normalized.startsWith('::ffff:')) {
    const ipv4Part = normalized.slice(7);
    if (isIP(ipv4Part) === 4) {
      return isPrivateIpv4(ipv4Part);
    }
    return true;
  }

  // fc00::/7 (Unique local address)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;

  // fe80::/10 (Link-local address)
  if (
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  ) {
    return true;
  }

  return false;
}

export function isPrivateIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return true; // Unknown is treated as unsafe
}

export interface SsrfGuardOptions {
  allowHttpForTesting?: boolean;
  allowedHosts?: readonly string[];
  dnsResolver?: (hostname: string) => Promise<{ address: string; family: number }[]>;
}

export async function validateUrlForSsrf(
  targetUrl: string | URL,
  options: SsrfGuardOptions = {},
): Promise<URL> {
  const parsed = typeof targetUrl === 'string' ? new URL(targetUrl) : targetUrl;

  // 1. Enforce HTTPS only (unless explicitly allowed in tests)
  if (parsed.protocol !== 'https:') {
    if (!options.allowHttpForTesting || parsed.protocol !== 'http:') {
      throw new SsrfError(
        `Invalid protocol '${parsed.protocol}'. Only HTTPS is permitted for external sources.`,
      );
    }
  }

  const hostname = parsed.hostname.toLowerCase();

  // Reject empty or local hostnames
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new SsrfError(`Access to host '${hostname}' is blocked by SSRF guard.`);
  }

  // 2. Check Host Allowlist if configured
  if (options.allowedHosts && options.allowedHosts.length > 0) {
    const isAllowed = options.allowedHosts.some(
      (allowed) => hostname === allowed.toLowerCase() || hostname.endsWith(`.${allowed.toLowerCase()}`),
    );
    if (!isAllowed) {
      throw new SsrfError(`Host '${hostname}' is not in the allowed sources list.`);
    }
  }

  // 3. If hostname is a literal IP address, validate immediately
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new SsrfError(`Target IP '${hostname}' belongs to a private/reserved address space.`);
    }
    return parsed;
  }

  // 4. Resolve hostname via DNS and validate all resolved addresses
  const resolver =
    options.dnsResolver ??
    (async (host: string) => {
      const records = await dnsPromises.lookup(host, { all: true });
      return records;
    });

  let records: { address: string; family: number }[];
  try {
    records = await resolver(hostname);
  } catch (err: unknown) {
    const errObj = err as Error;
    throw new SsrfError(
      `DNS resolution failed for host '${hostname}': ${errObj.message}`,
      { cause: err },
    );
  }

  if (!records || records.length === 0) {
    throw new SsrfError(`DNS resolution returned no IP records for '${hostname}'.`);
  }

  for (const record of records) {
    if (isPrivateIp(record.address)) {
      throw new SsrfError(
        `Host '${hostname}' resolved to private/reserved IP address '${record.address}'.`,
      );
    }
  }

  return parsed;
}
