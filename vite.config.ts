import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// public/music/ holds a soundtrack of your own for local play (see the help panel). It is not
// ours to publish, so a build never carries it: everything else in public/ is copied as usual.
function keepMusicLocal(): Plugin {
  let outDir = 'dist';
  return {
    name: 'keep-music-local',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      rmSync(resolve(outDir, 'music'), { recursive: true, force: true });
    },
  };
}

export default defineConfig({
  plugins: [keepMusicLocal()],
});
