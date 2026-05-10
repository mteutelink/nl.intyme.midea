'use strict';

export const MAX_AUTO_DISCOVERY_HOSTS = 512;
export const MIN_AUTO_DISCOVERY_PREFIX = 23;

function isIPv4(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => {
    const number = Number(part);
    return Number.isInteger(number) && number >= 0 && number <= 255 && String(number) === part;
  });
}

function ipToInt(value: string): number {
  return value.split('.').reduce((result, part) => ((result << 8) + Number(part)) >>> 0, 0);
}

function intToIp(value: number): string {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join('.');
}

export function getCidrHosts(address: string, prefix: number, maxHosts = MAX_AUTO_DISCOVERY_HOSTS): string[] {
  if (!isIPv4(address) || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error('Enter a valid IPv4 CIDR range');
  }

  if (prefix === 32) {
    return [address];
  }

  const size = 2 ** (32 - prefix);
  const hostCount = prefix >= 31 ? size : size - 2;
  if (hostCount > maxHosts) {
    throw new Error('CIDR range is too large; use /23 or a narrower range');
  }

  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ipToInt(address) & mask) >>> 0;
  const first = prefix >= 31 ? network : network + 1;
  const last = prefix >= 31 ? network + size - 1 : network + size - 2;
  const hosts: string[] = [];

  for (let ip = first; ip <= last; ip++) {
    hosts.push(intToIp(ip));
  }

  return hosts;
}

export function netmaskToPrefix(netmask: string): number {
  return ipToInt(netmask).toString(2).split('1').length - 1;
}

function getClassCHosts(address: string, maxHosts = MAX_AUTO_DISCOVERY_HOSTS): string[] {
  const network = ipToInt(address) & 0xffffff00;
  const hostCount = 256;
  if (hostCount > maxHosts) {
    throw new Error('Network range is too large');
  }

  const hosts: string[] = [];
  for (let offset = 0; offset < hostCount; offset++) {
    hosts.push(intToIp((network + offset) >>> 0));
  }

  return hosts;
}

export function getExplicitDiscoveryHosts(target: string, maxHosts = MAX_AUTO_DISCOVERY_HOSTS): string[] {
  const value = target.trim();
  const withoutGlobalBroadcast = (hosts: string[]) => hosts.filter((host) => host !== '255.255.255.255');

  if (value.includes('/')) {
    const parts = value.split('/');
    if (parts.length !== 2) {
      throw new Error('Enter a valid IPv4 CIDR range');
    }

    const [address, prefixText] = parts;
    const prefix = Number(prefixText);
    return withoutGlobalBroadcast(getCidrHosts(address, prefix, maxHosts));
  }

  if (!isIPv4(value)) {
    throw new Error('Enter an IPv4 address');
  }

  return withoutGlobalBroadcast(getClassCHosts(value, maxHosts));
}
