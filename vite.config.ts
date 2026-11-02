import { defineConfig, loadEnv } from 'vite';

// En développement, l'API Breign est servie via un proxy local (`/breign-api`) pour éviter
// les soucis de CORS depuis le navigateur. La cible se règle avec BREIGN_API_TARGET.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.BREIGN_API_TARGET || 'https://api.breign.eu';
  return {
    // 127.0.0.1 plutôt que localhost : c'est l'adresse de retour de « Se connecter avec Breign »
    // (loopback OAuth, RFC 8252), et Node peut sinon n'écouter que sur ::1.
    server: {
      host: '127.0.0.1',
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
      host: '127.0.0.1',
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
