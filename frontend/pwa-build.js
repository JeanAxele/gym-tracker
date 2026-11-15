import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export function pwaBuild() {
  return {
    name: 'gym-tracker-pwa',
    apply: 'build',
    async writeBundle(options, bundle) {
      const files = Object.keys(bundle).filter((file) => !file.endsWith('.map'));
      const publicFiles = ['manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
      const { resolve } = await import('node:path');
      const { writeFile } = await import('node:fs/promises');
      const hash = createHash('sha256');
      const worker = await readFile(new URL('./service-worker.js', import.meta.url), 'utf8');
      hash.update(worker);
      for (const file of [...files, ...publicFiles]) {
        hash.update(await readFile(resolve(options.dir, file)));
      }
      const config = {
        cache: 'gym-shell-' + hash.digest('hex').slice(0, 16),
        files: [...files, ...publicFiles].map((name) => '/' + name),
      };
      await writeFile(resolve(options.dir, 'sw.js'), worker.replace('__BUILD_CONFIG__', JSON.stringify(config)));
    },
  };
}
