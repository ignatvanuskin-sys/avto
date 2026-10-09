export default {
  plugins: {
    /**
     * Tailwind CSS v4 handles `@import` itself (including node_modules
     * resolution) and is the version the Astryx Tailwind bridge targets:
     * `@astryxdesign/core/tailwind-theme.css` uses `@theme reference inline`,
     * which only exists in v4.
     */
    '@tailwindcss/postcss': {},
  },
};
