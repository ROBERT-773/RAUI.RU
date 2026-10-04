import type { NextConfig } from 'next';
const config: NextConfig = {
  poweredByHeader: false,
  transpilePackages: ['@raui/ui', '@raui/types'],
  experimental: { cpus: 2 },
};
export default config;
