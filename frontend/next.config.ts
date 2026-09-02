import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Type errors fail the build instead of shipping past them. There is no
  // matching `eslint` key: Next 16 dropped `next lint` and its build-time ESLint
  // integration, so linting runs as its own `npm run lint` step (and in CI).
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
