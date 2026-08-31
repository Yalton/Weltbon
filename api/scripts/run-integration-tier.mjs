import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { filesForTier } from '../ci/integration-tiers.mjs';

const USAGE = 'Usage: node scripts/run-integration-tier.mjs <tier> [<shardIndex>/<shardCount>] [--list]';

export function shardFiles(files, index, count) {
  if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || index < 1 || index > count) {
    throw new Error('Invalid shard');
  }
  return files.filter((_, position) => position % count === index - 1);
}

function parseShard(value) {
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match) throw new Error('Invalid shard');
  return { index: Number(match[1]), count: Number(match[2]) };
}

function fail() {
  console.error(USAGE);
  process.exitCode = 2;
}

function main(args) {
  const list = args.includes('--list');
  const positional = args.filter((arg) => arg !== '--list');
  if (positional.length < 1 || positional.length > 2 || args.filter((arg) => arg === '--list').length > 1) {
    return fail();
  }

  let files;
  try {
    files = filesForTier(positional[0]);
    if (positional[1]) {
      const { index, count } = parseShard(positional[1]);
      files = shardFiles(files, index, count);
    }
  } catch {
    return fail();
  }

  if (list) {
    process.stdout.write(files.length ? `${files.join('\n')}\n` : '');
    return;
  }

  const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--project', 'integration', ...files], {
    stdio: 'inherit',
  });
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
