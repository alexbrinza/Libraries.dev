import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dts from 'vite-plugin-dts';
import { resolve } from 'path';

// Dev (`npm run dev`) serves the playground from the lib root. The lib build
// (`npm run build`) sets publicDir=false so no static assets leak into `dist/`.
const isLibBuild = process.env.npm_lifecycle_event === 'build';

export default defineConfig({
  plugins: [
    react(),
    isLibBuild &&
      dts({
        include: ['src'],
        rollupTypes: true
      })
  ].filter(Boolean),
  publicDir: isLibBuild ? false : resolve(__dirname, 'playground/public'),
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'InkjetFx',
      fileName: (format) => `index.${format === 'es' ? 'es' : 'cjs'}.js`,
      formats: ['es', 'cjs']
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime'],
      output: {
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
          'react/jsx-runtime': 'jsxRuntime'
        }
      }
    }
  }
});
