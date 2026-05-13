/** @type {import('next').NextConfig} */
const isProd = process.env.NODE_ENV === 'production';
const repo = 'stock-app-v2';

const nextConfig = {
  output: 'export',                      // static export for GitHub Pages
  images: { unoptimized: true },         // required for static export
  basePath: isProd ? `/${repo}` : '',    // GH Pages subpath
  assetPrefix: isProd ? `/${repo}/` : '',
  trailingSlash: true,                   // GH Pages friendliness
  reactStrictMode: true,
};

export default nextConfig;
