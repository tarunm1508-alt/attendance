const express = require("express");
const router = express.Router();
const pool = require("../db");

router.post("/login", async (req, res) => {
    const { username, password, student_usn, institutionId } = req.body;
    const targetTenant = institutionId || 'DR_AIT';

    try {
        console.log("Login attempt for parent:", username);

        // Query the 'users' table for the parent account with institution isolation
        const result = await pool.query(
            `SELECT * FROM users 
             WHERE UPPER(usn) = UPPER($1) 
               AND LOWER(TRIM(role)) = 'parent' 
               AND COALESCE(institution_id, 'DR_AIT') ILIKE $2`,
            [username ? username.trim() : '', targetTenant]
        );

        // If no user found
        if (result.rows.length === 0) {
            console.log("Parent not found in database");
            return res.status(401).json({ success: false, message: "Invalid Parent Credentials" });
        }

        const parent = result.rows[0];

        // Match password
        if (parent.password !== password) {
            console.log("Password mismatch for parent");
            return res.status(401).json({ success: false, message: "Invalid Parent Credentials" });
        }

        // Validate that the student USN entered on the screen matches the linked ward
        if (student_usn && parent.child_usn) {
            if (parent.child_usn.trim().toUpperCase() !== student_usn.trim().toUpperCase()) {
                console.log("Student USN mismatch for parent");
                return res.status(401).json({ 
                    success: false, 
                    message: "⚠️ Incorrect student USN. This USN does not match your registered ward." 
                });
            }
        }

        // Success - Send back the data including the child link and tenant
        console.log("Login successful for:", parent.name);
        res.json({
            success: true,
            user_name: parent.name,
            student_id: parent.child_usn,
            institutionId: parent.institution_id || targetTenant
        });

    } catch (err) {
        console.error("Database error:", err.message);
        res.status(500).json({ success: false, message: "Server Error" });
    }
});

module.exports = router;