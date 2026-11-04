export function parse(input: string, options?: { allowPrivateDomains?: boolean }): {
  isIp: boolean | null; isIcann: boolean | null; isPrivate: boolean | null; domain: string | null;
};
