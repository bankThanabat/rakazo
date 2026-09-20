/** The probe runs in the selected API image, using that deployment's DATABASE_URL. */
export const MIGRATION_STATE_PREFIX = "RAKAZO_MIGRATION_STATE=";
export const MIGRATION_STATE_PROBE = String.raw`
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const hash = value => createHash('sha256').update(value).digest('hex');
let client;
try {
  const url = process.env.DATABASE_URL;
  if (!url) throw Error('Database configuration missing');
  const { Client } = createRequire('/app/packages/db/package.json')('pg');
  client = new Client({connectionString:url,connectionTimeoutMillis:10000,query_timeout:10000,statement_timeout:10000});
  client.on('error',()=>{});
  await client.connect();
  const {rows:[identity]} = await client.query('SELECT current_database() AS database, current_schema() AS schema, inet_server_addr()::text AS server, inet_server_port() AS port');
  const address = new URL(url);
  const {rows} = await client.query('SELECT id, checksum, migration_name, started_at, finished_at, rolled_back_at, applied_steps_count FROM _prisma_migrations ORDER BY id');
  const complete = rows.every(row => row.finished_at !== null || row.rolled_back_at !== null);
  const applied = rows.filter(row => row.finished_at !== null && row.rolled_back_at === null);
  const directory = '/app/packages/db/prisma/migrations';
  const files = (await readdir(directory,{withFileTypes:true})).filter(entry=>entry.isDirectory());
  const checksums = await Promise.all(files.map(async entry => ({name:entry.name,checksum:hash(await readFile(directory+'/'+entry.name+'/migration.sql'))})));
  const matchesHistory = applied.every(row => checksums.some(file=>row.migration_name===file.name && row.checksum===file.checksum));
  const matchesImage = complete && matchesHistory && applied.length === checksums.length;
  // Never publish a hash of credentials or arbitrary URL parameters: it could verify password guesses.
  const database = hash(JSON.stringify({host:address.hostname,port:address.port,...identity}));
  console.log('RAKAZO_MIGRATION_STATE='+JSON.stringify({database,history:hash(JSON.stringify(rows)),complete,matchesHistory,matchesImage}));
} catch {
  console.error('Could not verify deployment migration state.');
  process.exitCode=1;
} finally {
  await client?.end().catch(()=>{});
}
`;

export interface MigrationState {
  database: string;
  history: string;
  complete: boolean;
  matchesHistory: boolean;
  matchesImage: boolean;
}

export function parseMigrationState(output: string): MigrationState | null {
  const lines = output.split(/\r?\n/).filter((line) => line.startsWith(MIGRATION_STATE_PREFIX));
  if (lines.length !== 1) return null;
  try {
    const value = JSON.parse(lines[0]!.slice(MIGRATION_STATE_PREFIX.length));
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.database !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.database) ||
      typeof value.history !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.history) ||
      typeof value.complete !== "boolean" ||
      typeof value.matchesHistory !== "boolean" ||
      typeof value.matchesImage !== "boolean"
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

export function canRestoreImage(before: MigrationState, after: MigrationState): boolean {
  return (
    before.complete &&
    before.matchesHistory &&
    after.complete &&
    after.matchesHistory &&
    after.matchesImage &&
    before.database === after.database &&
    before.history === after.history
  );
}
