import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
export class JsonStore<T> {
  constructor(
    private root: string,
    private name: string,
    private schema: z.ZodType<T>,
    private defaults: () => T,
  ) {}
  async read() {
    try {
      const value = JSON.parse(await readFile(join(this.root, this.name), 'utf8')) as unknown;
      return this.schema.parse(value);
    } catch {
      return this.defaults();
    }
  }
  async write(value: T) {
    const parsed = this.schema.parse(value);
    await mkdir(this.root, { recursive: true });
    const path = join(this.root, this.name),
      tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(parsed, null, 2));
    await rename(tmp, path);
  }
}
