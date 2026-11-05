import { build, transform } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const envs = {
  staging: { url: 'https://apicdwkwiqswdqefyfjp.supabase.co', key: 'sb_publishable_XzA9iE5C60ZAFxsT8vy7UQ_k8jDR-Ll' },
  ...(process.env.PROD_URL ? { production: { url: process.env.PROD_URL, key: process.env.PROD_KEY } } : {}),
};
mkdirSync('dist', { recursive: true });
const manifest = {};
for (const mode of ['article', 'dashboard']) {
  const cssSrc = readFileSync(mode === 'article' ? 'src/styles.css' : 'src/dash.css', 'utf8');
  const css = (await transform(cssSrc, { loader: 'css', minify: true })).code.trim();
  for (const [env, c] of Object.entries(envs)) {
    const r = await build({
      entryPoints: ['src/main.js'], bundle: true, minify: true, format: 'iife', target: ['es2020', 'safari15'],
      write: false, legalComments: 'none',
      define: { __SB_URL__: JSON.stringify(c.url), __SB_KEY__: JSON.stringify(c.key), __VERSION__: JSON.stringify(pkg.version),
        __MODE__: JSON.stringify(mode), __CSS__: JSON.stringify(css) },
    });
    const js = r.outputFiles[0].text;
    const file = `dist/${mode}.${env}.js`;
    writeFileSync(file, js);
    const sri = 'sha384-' + createHash('sha384').update(js).digest('base64');
    manifest[`${mode}.${env}`] = { file, bytes: Buffer.byteLength(js), sri };
  }
}
writeFileSync('dist/manifest.json', JSON.stringify({ version: pkg.version, files: manifest }, null, 2));
console.log(JSON.stringify(manifest, null, 2));
