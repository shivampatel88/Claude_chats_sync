const fs = require('fs');
const esbuild = require('esbuild');

let envKey = '';
try {
  if (fs.existsSync('.env')) {
    const envContent = fs.readFileSync('.env', 'utf8');
    const match = envContent.match(/^EMBEDDING_KEY=(.*)$/m);
    if (match && match[1]) {
      envKey = match[1].trim();
    }
  }
} catch (e) {
  console.warn('Warning: Could not read .env file', e);
}

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
  format: 'iife',
  define: {
    'process.env.EMBEDDING_KEY': JSON.stringify(envKey)
  }
}).then(() => {
  console.log('Build completed successfully.');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
