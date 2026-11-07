import { mergeConfig } from 'vite';
import base from '../vite.config';

export default mergeConfig(base, {
  root: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  cacheDir: 'node_modules/.vite-e2e',
  server: { host: '127.0.0.1', port: 4192, strictPort: true, hmr: false, watch: null },
});
