import shared from '@switz/lint-config/oxfmt' with { type: 'json' };

export default {
  ...shared,
  // src/gapless.js is the legacy v3 UMD build, kept verbatim.
  ignorePatterns: ['dist', 'demo/.timber', 'pnpm-lock.yaml', 'artifacts', 'src/gapless.js'],
};
