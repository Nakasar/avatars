import { defineConfig, loadEnv } from 'vite';

// En développement, l'API Breign est servie via un proxy local (`/breign-api`) pour éviter
// les soucis de CORS depuis le navigateur. La cible se règle avec BREIGN_API_TARGET.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.BREIGN_API_TARGET || 'https://api.breign.eu';
  return {
    server: {
      proxy: {
        '/breign-api': {
          target,
          changeOrigin: true,
          secure: true,
          rewrite: (path) => path.replace(/^\/breign-api/, ''),
        },
      },
    },
    preview: {
      proxy: {
        '/breign-api': {
          target,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/breign-api/, ''),
        },
      },
    },
    optimizeDeps: { include: ['@breign/client'] },
    build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  };
});
