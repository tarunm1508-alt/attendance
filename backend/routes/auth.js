const express = require('express');
const router = express.Router();
const pool = require('../db'); // Connects to your PostgreSQL db configuration module

// ==========================================
// 1. SIGNUP ROUTE (With Parent Database Linking)
// ==========================================
router.post("/signup", async (req, res) => {
    // 🎯 ADDED: childUsn grabbed safely from the frontend payload
    const { usn, email, password, role, name, childUsn } = req.body;
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const userExists = await client.query("SELECT * FROM users WHERE usn = $1 OR email = $2", [usn, email]);
        if (userExists.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: "This USN or Email address is already registered." });
        }

        // 🎯 FIXED: Maps 6 elements now, handling the parent-child relational link safely
        await client.query(
            "INSERT INTO users (usn, email, password, role, name, child_usn) VALUES ($1, $2, $3, $4, $5, $6)",
            [usn, email, password, role.toLowerCase(), name || usn, childUsn || null]       
        );

        if (role.toLowerCase() === 'student') {
            const subjects = ['DBMS', 'AI', 'ADA', 'MERN', 'CDN'];
            for (let sub of subjects) {
                await client.query(
                    "INSERT INTO subject_attendance (usn, subject_name, attended_classes, total_classes) VALUES ($1, $2, 0, 0)",
                    [usn, sub]
                );
            }
        }

        await client.query('COMMIT');
        return res.status(201).json({ success: true, userId: usn });

    } catch (err) {
        await client.query('ROLLBACK');
        return res.status(500).json({ message: "Database Storage Error: " + err.message });
    } finally {
        client.release();
    }
});

// ==========================================
// 2. SECURE VERIFICATION STEP: Sync Key to DB
// ==========================================
router.post("/verify-registration", async (req, res) => {
    try {
        const { userId, id } = req.body;
        await pool.query(
            "UPDATE users SET device_token = $1 WHERE usn = $2",
            [id, userId]
        );
        return res.status(200).json({ success: true, message: "Biometric security hash saved successfully!" });
    } catch (err) {
        console.error("❌ Sink dropped during signature verify:", err.message);
        return res.status(500).json({ message: "Failed parsing encryption signature variables back to database." });
    }
});

// ==========================================
// 3. COMBINED LOGIN ROUTE (Returns Linked Data)
// ==========================================
router.post("/combined-login", async (req, res) => {
    const { usn, password, role, biometricKey } = req.body;
    try {
        const result = await pool.query("SELECT * FROM users WHERE usn = $1 AND role = $2", [usn, role.toLowerCase()]);
        if (result.rows.length === 0) {
            return res.status(400).json({ message: "User identity record not found in database." });
        }

        const user = result.rows[0];
        if (user.password !== password) {
            return res.status(400).json({ message: "Incorrect security password credentials." });
        }

        if (user.device_token && user.device_token !== biometricKey) {
            return res.status(403).json({ message: "SECURITY ALARM: FRAUDULENT PATTERN REJECTED ❌" });
        }

        // 🎯 FIXED: Returns child_usn and role parameters back to the login session storage engine
        return res.json({ 
            success: true, 
            usn: user.usn, 
            name: user.name, 
            role: user.role,
            childUsn: user.child_usn 
        });
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
});

// ==========================================
// 4. LOCK STATUS CHECKER (Optimized for Live Demo)
// ==========================================
router.get("/check-lock/:usn", async (req, res) => {
    try {
        const result = await pool.query("SELECT device_token FROM users WHERE usn = $1", [req.params.usn]);
        if (result.rows.length > 0 && result.rows[0].device_token) {
            return res.json({ isLocked: true, token: result.rows[0].device_token });
        }
        return res.json({ isLocked: false });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// ==========================================
// 5. PROFILE DATA RETRIEVER ROUTE
// ==========================================
router.get("/profile/:usn", async (req, res) => {
    try {
        // 🎯 FIXED: Added child_usn and role into profile tracking data packet mappings
        const result = await pool.query("SELECT name, usn, role, child_usn FROM users WHERE usn = $1", [req.params.usn]);
        if (result.rows.length > 0) {
            return res.json(result.rows[0]);
        }
        return res.status(404).json({ message: "Profile not found" });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// 🎯 CRITICAL EXPORT: Prevents server.js from crashing!
module.exports = router;















