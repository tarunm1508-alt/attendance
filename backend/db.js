const { Pool } = require('pg');
require('dotenv').config(); // Load environment variables from .env file

// Use Cloud Connection String if provided, otherwise use Localhost default
const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:YOUR_LOCAL_PASSWORD@localhost:5432/YOUR_LOCAL_DB';

const isCloud = connectionString.includes('neon.tech') || connectionString.includes('render') || connectionString.includes('supabase') || process.env.NODE_ENV === 'production';

const pool = new Pool({
    connectionString: connectionString,
    ssl: isCloud ? { rejectUnauthorized: false } : false, // Required for Cloud DBs (Neon / Supabase / Render)
    max: 15,
    idleTimeoutMillis: 20000,         // Clean up idle clients safely
    connectionTimeoutMillis: 10000,   // Handle cloud cold starts smoothly
    keepAlive: true,                  // 🔌 Keeps TCP connection alive to prevent unexpected drops
    keepAliveInitialDelayMillis: 10000
});

pool.on('connect', () => {
    console.log(isCloud ? '☁️ Connected to Cloud PostgreSQL Database!' : '💻 Connected to Local PostgreSQL Database!');
});

// Gracefully handle sudden socket closures or idle terminations without crashing terminal
pool.on('error', (err, client) => {
    if (err.message.includes('terminating connection') || err.message.includes('Connection terminated') || err.code === '57P01') {
        // This is a standard cloud idle timeout recycle—safe to handle quietly
        return;
    }
    console.error('⚠️ Warning: Database idle client error encountered:', err.message);
});

// 🛡️ ULTRA-ROBUST QUERY WRAPPER WITH AUTO-RETRY FOR ATTENDANCE
module.exports = {
    query: async (text, params) => {
        try {
            return await pool.query(text, params);
        } catch (error) {
            // If connection drops during a query, auto-retry once instantly so attendance never fails
            if (error.code === 'ECONNRESET' || error.message.includes('terminated') || error.message.includes('closed')) {
                console.warn('🔄 Network blink detected. Automatically retrying database operation...');
                return await pool.query(text, params);
            }
            throw error;
        }
    },
    pool
};