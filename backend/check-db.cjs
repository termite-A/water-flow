require('dotenv').config();

const { Client } = require('pg');

const client = new Client({
  connectionString: process.env.DATABASE_URL,
});

async function check() {
  try {
    await client.connect();

    const info = await client.query(`
      SELECT
        current_database() AS database,
        current_schema() AS schema,
        inet_server_addr() AS server,
        inet_server_port() AS port
    `);

    console.log('\nDATABASE CONNECTION:');
    console.table(info.rows);

    const tables = await client.query(`
      SELECT
        table_schema,
        table_name
      FROM information_schema.tables
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name
    `);

    console.log('\nTABLES:');
    console.table(tables.rows);

  } catch (error) {
    console.error('\nERROR:', error.message);
  } finally {
    await client.end();
  }
}

check();