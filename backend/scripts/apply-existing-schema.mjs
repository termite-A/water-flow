import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not configured in backend/.env.')
  process.exit(1)
}

const schemaPath = fileURLToPath(new URL('../sql/water_conn.session.sql', import.meta.url))
const schema = readFileSync(schemaPath, 'utf8')
const client = new pg.Client({ connectionString: process.env.DATABASE_URL })

try {
  await client.connect()
  await client.query(schema)
  const result = await client.query('SELECT device_code FROM devices ORDER BY device_code LIMIT 20')
  console.log('Existing database schema extensions applied.')
  console.log(`Registered device codes: ${result.rows.map((row) => row.device_code).join(', ') || '(none)'}`)
} catch (error) {
  console.error('Schema apply failed:', error.code ?? 'unknown', error.message)
  process.exitCode = 1
} finally {
  await client.end().catch(() => {})
}
