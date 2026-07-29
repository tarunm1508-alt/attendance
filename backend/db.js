const { Pool } = require('pg');
require('dotenv').config(); // Load environment variables from .env file

// Use Cloud Connection String if provided, otherwise use Localhost default
const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:YOUR_LOCAL_PASSWORD@localhost:5432/YOUR_LOCAL_DB';

const isCloud = connectionString.includes('neon.tech') || connectionString.includes('render') || connectionString.includes('supabase') || process.env.NODE_ENV === 'production';

const pool = new Pool({
    connectionString: connectionString,
    ssl: isCloud ? { rejectUnauthorized: false } : false, // Required for Cloud DBs (Neon / Supabase / Render)
    max: 10,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000 // Increased to 10 seconds to handle cloud cold starts smoothly
});

pool.on('connect', () => {
    console.log(isCloud ? '☁️ Connected to Cloud PostgreSQL Database!' : '💻 Connected to Local PostgreSQL Database!');
});

pool.on('error', (err) => {
    console.error('❌ Database Pool Error:', err.message);
});

module.exports = pool;