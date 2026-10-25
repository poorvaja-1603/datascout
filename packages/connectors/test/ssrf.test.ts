import { describe, expect, it } from 'vitest';
import {
  isPrivateIpv4,
  isPrivateIpv6,
  validateUrlForSsrf,
  SsrfError,
} from '../src/toolkit/ssrf.js';

describe('SSRF Guard', () => {
  describe('isPrivateIpv4', () => {
    it('detects loopback addresses', () => {
      expect(isPrivateIpv4('127.0.0.1')).toBe(true);
      expect(isPrivateIpv4('127.0.1.10')).toBe(true);
    });

    it('detects AWS/cloud metadata address (169.254.169.254)', () => {
      expect(isPrivateIpv4('169.254.169.254')).toBe(true);
      expect(isPrivateIpv4('169.254.0.1')).toBe(true);
    });

    it('detects RFC 1918 private subnets', () => {
      expect(isPrivateIpv4('10.0.0.1')).toBe(true);
      expect(isPrivateIpv4('10.255.255.255')).toBe(true);
      expect(isPrivateIpv4('172.16.0.1')).toBe(true);
      expect(isPrivateIpv4('172.31.255.255')).toBe(true);
      expect(isPrivateIpv4('192.168.0.1')).toBe(true);
      expect(isPrivateIpv4('192.168.1.100')).toBe(true);
    });

    it('detects broadcast, documentation, and reserved ranges', () => {
      expect(isPrivateIpv4('0.0.0.0')).toBe(true);
      expect(isPrivateIpv4('192.0.2.1')).toBe(true);
      expect(isPrivateIpv4('198.51.100.1')).toBe(true);
      expect(isPrivateIpv4('203.0.113.1')).toBe(true);
      expect(isPrivateIpv4('224.0.0.1')).toBe(true);
      expect(isPrivateIpv4('255.255.255.255')).toBe(true);
    });

    it('identifies valid public IPv4 addresses', () => {
      expect(isPrivateIpv4('8.8.8.8')).toBe(false);
      expect(isPrivateIpv4('1.1.1.1')).toBe(false);
      expect(isPrivateIpv4('142.250.190.46')).toBe(false);
    });
  });

  describe('isPrivateIpv6', () => {
    it('detects loopback and unspecified addresses', () => {
      expect(isPrivateIpv6('::1')).toBe(true);
      expect(isPrivateIpv6('::')).toBe(true);
    });

    it('detects unique local (fc00::/7) and link-local (fe80::/10)', () => {
      expect(isPrivateIpv6('fc00::1')).toBe(true);
      expect(isPrivateIpv6('fd12:3456:789a::1')).toBe(true);
      expect(isPrivateIpv6('fe80::1')).toBe(true);
    });

    it('detects IPv4-mapped private IPv6', () => {
      expect(isPrivateIpv6('::ffff:127.0.0.1')).toBe(true);
      expect(isPrivateIpv6('::ffff:192.168.1.1')).toBe(true);
      expect(isPrivateIpv6('::ffff:169.254.169.254')).toBe(true);
      expect(isPrivateIpv6('::ffff:8.8.8.8')).toBe(false);
    });
  });

  describe('validateUrlForSsrf', () => {
    it('rejects non-HTTPS protocols by default', async () => {
      await expect(validateUrlForSsrf('http://example.com')).rejects.toThrow(
        SsrfError,
      );
      await expect(validateUrlForSsrf('file:///etc/passwd')).rejects.toThrow(
        SsrfError,
      );
      await expect(validateUrlForSsrf('ftp://example.com')).rejects.toThrow(
        SsrfError,
      );
    });

    it('rejects localhost and literal loopback IPs', async () => {
      await expect(validateUrlForSsrf('https://localhost/api')).rejects.toThrow(
        SsrfError,
      );
      await expect(validateUrlForSsrf('https://127.0.0.1/api')).rejects.toThrow(
        SsrfError,
      );
    });

    it('rejects cloud metadata IP', async () => {
      await expect(
        validateUrlForSsrf('https://169.254.169.254/latest/meta-data/'),
      ).rejects.toThrow(SsrfError);
    });

    it('rejects host resolving to private IP via custom DNS resolver', async () => {
      const mockResolver = async () => [{ address: '10.0.0.5', family: 4 }];
      await expect(
        validateUrlForSsrf('https://evil-internal.example.com', {
          dnsResolver: mockResolver,
        }),
      ).rejects.toThrow(SsrfError);
    });

    it('allows valid public host with public IP resolution', async () => {
      const mockResolver = async () => [
        { address: '93.184.216.34', family: 4 },
      ];
      const valid = await validateUrlForSsrf(
        'https://api.data.gov.in/resource',
        {
          dnsResolver: mockResolver,
        },
      );
      expect(valid.hostname).toBe('api.data.gov.in');
    });

    it('enforces allowedHosts allowlist when configured', async () => {
      const mockResolver = async () => [
        { address: '93.184.216.34', family: 4 },
      ];
      await expect(
        validateUrlForSsrf('https://untrusted-portal.org/data', {
          allowedHosts: ['data.gov.in', 'huggingface.co'],
          dnsResolver: mockResolver,
        }),
      ).rejects.toThrow(/not in the allowed sources/);

      const allowed = await validateUrlForSsrf('https://data.gov.in/catalog', {
        allowedHosts: ['data.gov.in'],
        dnsResolver: mockResolver,
      });
      expect(allowed.hostname).toBe('data.gov.in');
    });
  });
});
