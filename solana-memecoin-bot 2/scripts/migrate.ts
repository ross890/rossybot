// ===========================================
// DATABASE MIGRATION SCRIPT
// ===========================================

import { pool, SCHEMA_SQL } from '../src/utils/database.js';

async function migrate(): Promise<void> {
  console.log('Running database migrations...');
  
  try {
    const client = await pool.connect();
    await client.query(SCHEMA_SQL);
    client.release();
    
    console.log('✅ Database migrations complete');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
