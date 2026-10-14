const esbuild = require('esbuild');

esbuild.build({
  entryPoints: [
    'src/shared/search-storage.ts',
    'src/shared/search-engine.ts',
    'src/shared/embedding-api.ts',
    'src/content/search-indexer.ts'
  ],
  outdir: 'dist',
  bundle: false,
  platform: 'browser',
  format: 'iife'
}).then(() => {
  console.log('Build completed successfully.');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
