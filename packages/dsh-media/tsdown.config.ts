import { defineConfig } from 'tsdown'

// The client half of the plugin is bundled as a DSH module-loader bundle, so it
// can be injected through the desktop's client composition (see `dsh.client` in
// package.json). `id` must match the package name exactly.
const PACKAGE_NAME = '@bhzhangsun/dsh-media'

export default defineConfig({
  name: `${PACKAGE_NAME}/client`,
  entry: { client: 'src/client/index.ts' },
  tsconfig: 'tsconfig.client.json',
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: true,
  // Only packages the client half actually imports: React and Cordis are
  // provided by the DSH client runtime, so they must stay unbundled.
  external: [
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/cordis',
  ],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
