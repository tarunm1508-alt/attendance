const express = require('express');
const router = express.Router();
const pool = require('../db'); 

// ==========================================================================
// 1. SUBMIT ATTENDANCE (With Bulletproof Single-Scan Constraints)
// ==========================================================================
router.post("/submit-attendance", async (req, res) => {
    const { studentId, subjectName, sessionCode, distance } = req.body;
    
    console.log(`\n📡 [ATTENDANCE TRANSACTION] Student: ${studentId} | Code: ${sessionCode}`);

    try {
        // 🎯 CONSTRAINT GATE: Checks if this exact USN has already checked into this unique session token
        const duplicateCheck = await pool.query(
            "SELECT * FROM users_attendance WHERE student_id = $1 AND session_code = $2",
            [studentId, sessionCode]
        );

        if (duplicateCheck.rows.length > 0) {
            console.log(`⚠️ [DUPLICATE BLOCKED] Student ${studentId} attempted a secondary scan for token: ${sessionCode}`);
            return res.status(400).json({ message: "Security Rule: You have already marked your attendance for this specific class session!" });
        }

        // If pristine, log the structural row into the tracking grid safely
        await pool.query(
            "INSERT INTO users_attendance (student_id, subject_name, session_code, distance, created_at) VALUES ($1, $2, $3, $4, NOW())",
            [studentId, subjectName || 'AI', sessionCode, distance || '0.22']
        );
        
        console.log(`✅ [ATTENDANCE CAPTURED] Row logged securely for: ${studentId}`);
        return res.status(200).json({ success: true, message: "Attendance registered successfully!" });
    } catch (err) {
        console.error("❌ [WRITE COLLISION] Fail:", err.message);
        return res.status(500).json({ message: "Server Database Error: " + err.message });
    }
});

// ==========================================================================
// 2. FETCH RECORDS (With Advanced SQL Join to Extract Real Student Names)
// ==========================================================================
router.get("/attendance-records", async (req, res) => {
    try {
        // 🎯 RELATIONAL JOIN: Matches rows on user accounts table to fetch names automatically
        const result = await pool.query(`
            SELECT a.id, a.student_id, a.session_code, a.distance, a.created_at, a.subject_name,
                   u.name AS student_full_name
            FROM users_attendance a
            LEFT JOIN users u ON a.student_id = u.usn
            ORDER BY a.created_at DESC
        `);
        return res.json(result.rows);
    } catch (err) {
        console.error("❌ Failed streaming relational columns:", err.message);
        return res.status(500).json({ error: err.message });
    }
});

// ==========================================================================
// 3. SIGNUP ROUTE
// ==========================================================================
router.post("/signup", async (req, res) => {
    const { usn, email, password, role, name, childUsn, subjectName } = req.body;
    console.log(`\n📥 [SIGNUP INCOMING] USN/ID: ${usn} | Role: ${role}`);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const userExists = await client.query("SELECT * FROM users WHERE usn = $1 OR email = $2", [usn, email]);
        if (userExists.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: "This USN or Email address is already registered." });
        }

        await client.query(
            "INSERT INTO users (usn, email, password, role, name, child_usn, subject_name) VALUES ($1, $2, $3, $4, $5, $6, $7)",
            [usn, email, password, role.toLowerCase(), name || usn, childUsn || null, role.toLowerCase() === 'teacher' ? subjectName : null]       
        );

        await client.query('COMMIT');
        return res.status(201).json({ success: true, userId: usn });
    } catch (err) {
        await client.query('ROLLBACK');
        return res.status(500).json({ message: "Database Storage Error: " + err.message });
    } finally {
        client.release();
    }
});

// ==========================================================================
// 4. COMBINED LOGIN ROUTE
// ==========================================================================
router.post("/combined-login", async (req, res) => {
    const { usn, password, role, biometricKey } = req.body;
    try {
        const result = await pool.query("SELECT * FROM users WHERE usn = $1 AND role = $2", [usn, role.toLowerCase()]);
        if (result.rows.length === 0) return res.status(400).json({ message: "User not found." });

        const user = result.rows[0];
        if (user.password !== password) return res.status(400).json({ message: "Incorrect password." });

        return res.json({ 
            success: true, 
            usn: user.usn, 
            name: user.name, 
            role: user.role,
            subjectName: user.subject_name 
        });
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
});

// ==========================================================================
// 5. EMERGENCY RESET ROUTE
// ==========================================================================
router.get("/danger-zone-flush", async (req, res) => {
    try {
        await pool.query("TRUNCATE TABLE users_attendance, users RESTART IDENTITY CASCADE;");
        return res.status(200).send("Database wiped perfectly clean!");
    } catch (err) {
        return res.status(500).send("Wipe Failed: " + err.message);
    }
});

module.exports = router;