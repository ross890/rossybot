import pg from 'pg';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.database.url,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected database pool error');
});

export async function query<T extends pg.QueryResultRow = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  const result = await pool.query<T>(text, params);
  const duration = Date.now() - start;
  if (duration > 1000) {
    logger.warn({ text: text.slice(0, 80), duration }, 'Slow query');
  }
  return result;
}

export async function getOne<T extends pg.QueryResultRow = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<T | null> {
  const result = await query<T>(text, params);
  return result.rows[0] ?? null;
}

export async function getMany<T extends pg.QueryResultRow = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await query<T>(text, params);
  return result.rows;
}

export async function testConnection(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    logger.info('Database connection OK');
    return true;
  } catch (err) {
    logger.error({ err }, 'Database connection failed');
    return false;
  }
}
