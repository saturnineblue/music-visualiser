import { defineConfig, loadEnv } from 'vite';
import { visualiserApi } from './server/plugin';

export default defineConfig(({ mode }) => {
  // '' prefix: load all vars (server side only; nothing is exposed to the browser).
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [visualiserApi(env)],
    server: {
      host: '127.0.0.1', // local only
      port: 5173,
      watch: { ignored: ['**/.history/**'] },
    },
  };
});
