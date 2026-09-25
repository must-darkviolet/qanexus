/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  // The API runs as a separate service; the dashboard proxies to it so the
  // browser never needs to know the backend's address (and CORS stays simple).
  async rewrites() {
    const target = process.env.API_URL ?? 'http://localhost:4000';
    return [{ source: '/api/:path*', destination: `${target}/api/:path*` }];
  },
};
