import { defineConfig } from 'astro/config';
export default defineConfig({
  output: 'static',
  site: process.env.SITE_URL || 'https://pcnngyy.github.io',
  base: process.env.BASE_PATH ?? '/figmaeval/',
  trailingSlash: 'always',
});
