import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['@distube/ytdl-core', 'youtubei.js'],
};

export default nextConfig;
