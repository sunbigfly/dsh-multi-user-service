import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
const zh = JSON.parse(await readFile(new URL('../locale/zh.json', import.meta.url))).meta;
const en = JSON.parse(await readFile(new URL('../locale/en.json', import.meta.url))).meta;
const repository = pkg.repository.url.replace(/\.git$/, '');
const repo = new URL(repository);
if (repo.hostname !== 'github.com') throw new Error('A GitHub repository is required.');
const icon = `https://raw.githubusercontent.com${repo.pathname}/main/${pkg.exports['./icon'].replace(/^\.\//, '')}`;
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('A committed source snapshot is required.');
const index = {
  format: 1,
  title: { zh: zh.title, en: en.title },
  description: { zh: zh.description, en: en.description },
  plugins: [{
    name: pkg.name, title: { zh: zh.title, en: en.title },
    description: { zh: zh.description, en: en.description },
    icon, author: repo.pathname.split('/')[1], homepage: pkg.homepage,
    repository: { url: repository },
    metadata: { keywords: pkg.keywords },
    versions: [{ version: pkg.version, publishTimestamp: Math.floor(Date.now() / 1000), source: { type: 'git', url: pkg.repository.url, commit }, engines: { dsh: '0.2.1-rc.2' } }],
  }],
};
await mkdir(new URL('../output/', import.meta.url), { recursive: true });
await writeFile(new URL('../output/index.json', import.meta.url), JSON.stringify(index, null, 2) + '\n');
process.stdout.write(`Created output/index.json for ${pkg.name}@${pkg.version}\n`);
