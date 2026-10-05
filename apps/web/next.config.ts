import type { NextConfig } from 'next';
const config: NextConfig = {
  poweredByHeader: false,
  htmlLimitedBots: /.*/, // Resolve listing eligibility/metadata before streaming headers.
  transpilePackages: ['@raui/ui', '@raui/types'],
  experimental: { cpus: 2 },
};
export default config;
