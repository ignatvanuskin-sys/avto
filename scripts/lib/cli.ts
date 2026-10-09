import process from 'node:process';
import { listTenantSlugs } from './tenant-config';

export interface CliArgs {
  /** Tenant slugs requested explicitly. */
  slugs: string[];
  /** --all was passed. */
  all: boolean;
  flags: Set<string>;
  /** Value of --only-tenant=... style options. */
  options: Map<string, string>;
}

export function parseArgs(argv = process.argv.slice(2)): CliArgs {
  const slugs: string[] = [];
  const flags = new Set<string>();
  const options = new Map<string, string>();

  for (const arg of argv) {
    if (arg === '--all') {
      flags.add('all');
      continue;
    }
    if (arg.startsWith('--')) {
      const [name, value] = arg.slice(2).split('=', 2);
      if (!name) continue;
      if (value === undefined) {
        flags.add(name);
      } else {
        options.set(name, value);
      }
      continue;
    }
    slugs.push(arg);
  }

  return { slugs, all: flags.has('all'), flags, options };
}

/**
 * Resolve which tenants a command should act on.
 *
 * Three modes, in order of precedence: explicit slugs, `--all`, or — when
 * running with `--changed` — every tenant. Being explicit matters because
 * `tenant:publish` writes to the database.
 */
export async function resolveTargets(args: CliArgs): Promise<string[]> {
  if (args.slugs.length > 0) {
    return [...new Set(args.slugs)].sort();
  }

  const available = await listTenantSlugs();

  if (args.all || args.flags.has('changed') || available.length === 1) {
    return available;
  }

  if (available.length === 0) {
    return [];
  }

  throw new Error(
    `Refusing to guess. Pass one or more slugs, or --all.\nAvailable tenants: ${available.join(', ')}`,
  );
}

export function logSection(title: string): void {
  console.log(`\n=== ${title} ===`);
}

export function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}
