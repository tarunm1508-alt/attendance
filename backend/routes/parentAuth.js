const express = require("express");
const router = express.Router();
const pool = require("../db");

router.post("/login", async (req, res) => {
    // 1. Check if your frontend is sending 'username' or 'usn'
    // I am using 'username' here to match your previous parentAuth snippet
    const { username, password } = req.body;

    try {
        console.log("Login attempt for:", username);

        // 2. Query the 'users' table exactly as it appears in your pgAdmin
        const result = await pool.query(
            "SELECT * FROM users WHERE usn = $1 AND role = 'parent'",
            [username]
        );

        // 3. If no user found
        if (result.rows.length === 0) {
            console.log("Parent not found in database");
            return res.status(401).json({ success: false, message: "Invalid Parent Credentials" });
        }

        const parent = result.rows[0];

        // 4. Match password
        if (parent.password !== password) {
            console.log("Password mismatch for parent");
            return res.status(401).json({ success: false, message: "Invalid Parent Credentials" });
        }

        // 5. Success - Send back the data including the child link
        console.log("Login successful for:", parent.name);
        res.json({
            success: true,
            user_name: parent.name,
            student_id: parent.child_usn // Ensure you ran the ALTER TABLE command in pgAdmin
        });

    } catch (err) {
        console.error("Database error:", err.message);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

module.exports = router;
module.exports = router;