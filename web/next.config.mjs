/** @type {import('next').NextConfig} */
const nextConfig = {
  // osobny katalog pozwala zrobić `next build` bez zatrzymywania działającego `next dev`
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
