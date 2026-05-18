const { Pool } = require("pg");

const pool = new Pool({
  user: "postgres",
  host: "localhost",
  database: "test_db1",
  password: "200715",
  port: 5432,
});

module.exports = pool;