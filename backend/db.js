const { Pool } = require('pg');
require('dotenv').config(); // Load environment variables from .env file

// Use Cloud Connection String if provided, otherwise use Localhost default
const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:YOUR_LOCAL_PASSWORD@localhost:5432/YOUR_LOCAL_DB';

const isCloud = connectionString.includes('neon.tech') || connectionString.includes('render') || connectionString.includes('supabase') || process.env.NODE_ENV === 'production';

const pool = new Pool({
    connectionString: connectionString,
    ssl: isCloud ? { rejectUnauthorized: false } : false, // Required for Cloud DBs (Neon / Supabase / Render)
    max: 10,
    idleTimeoutMillis: 30000, // Increased to 30 seconds for better idle stability
    connectionTimeoutMillis: 10000 // 10 seconds to handle cloud cold starts smoothly
});

pool.on('connect', () => {
    console.log(isCloud ? '☁️ Connected to Cloud PostgreSQL Database!' : '💻 Connected to Local PostgreSQL Database!');
});

// Robust error listener to handle sudden socket closures or idle terminations smoothly
pool.on('error', (err, client) => {
    console.error('⚠️ Warning: Database idle client error encountered:', err.message);
    // The pool will automatically handle reconnecting dead clients on the next query
});

module.exports = pool;