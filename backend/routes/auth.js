const express = require("express");
const router = express.Router();
const pool = require("../db");

// 1. UNIFIED COMBINED BIOMETRIC + PASSWORD ROUTE (Enforces Strict Fingerprint Matching)
router.post("/combined-login", async (req, res) => {
    try {
        const { usn, password, role, biometricKey } = req.body;

        console.log(`🔒 Combined Auth Attempt: USN=${usn}, Role=${role}`);

        const userQuery = await pool.query(
            "SELECT * FROM users WHERE usn = $1 AND role = $2",
            [usn, role]
        );

        if (userQuery.rows.length === 0) {
            return res.status(404).json({ message: "User not found with this role specification." });
        }

        const user = userQuery.rows[0];

        // Step 1: Validate Password 
        if (user.password !== password) {
            return res.status(401).json({ message: "Incorrect password credentials." });
        }

        // Step 2: Strictly Enforce Biometric Key Comparison
        if (role === 'student') {
            if (!user.device_token) {
                return res.status(400).json({ message: "Biometric profile not registered yet. Please register via Signup." });
            }
            
            if (user.device_token !== biometricKey) {
                return res.status(403).json({ 
                    message: "Biometric Verification Failed: Fraudulent pattern rejected! This profile belongs to a different fingerprint key map. ⚠️" 
                });
            }
        }

        return res.status(200).json({
            message: "Biometric identity verified smoothly!",
            user: { usn: user.usn, name: user.name, role: user.role }
        });

    } catch (err) {
        console.error("Combined Auth Route Error:", err.message);
        return res.status(500).json({ message: "Server error during authentication." });
    }
});

// 2. SIGNUP ROUTE (Now captures and saves the fingerprint token permanently during registration)
router.post("/register", async (req, res) => {
    const client = await pool.connect();
    try {
        const { usn, name, email, password, role, child_usn, biometricKey } = req.body;

        await client.query('BEGIN');

        const emailExists = await client.query("SELECT * FROM users WHERE email = $1", [email]);
        if (emailExists.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: "This email address is already registered." });
        }

        const userExists = await client.query("SELECT * FROM users WHERE usn = $1", [usn]);
        if (userExists.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: "This USN or User ID is already taken." });
        }

        if (role === 'parent') {
            if (!child_usn) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: "Parent registration requires a child's USN." });
            }
            const childExists = await client.query("SELECT * FROM users WHERE usn = $1 AND role = 'student'", [child_usn]);
            if (childExists.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ message: `Child USN (${child_usn}) does not exist.` });
            }
        }

        // 🎯 FIXED: Inserts the generated biometricKey directly into the device_token column upon signup!
        const newUserResult = await client.query(
            "INSERT INTO users (usn, name, email, password, role, child_usn, device_token) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *",
            [usn, name, email, password, role.toLowerCase(), (role === 'parent' ? child_usn : null), (role === 'student' ? biometricKey : null)]       
        );

        if (role === 'student') {
            const subjects = ['DBMS', 'AI', 'ADA', 'MERN', 'CDN'];
            for (let sub of subjects) {
                await client.query(
                    "INSERT INTO subject_attendance (usn, subject_name, attended_classes, total_classes) VALUES ($1, $2, 0, 0)",
                    [usn, sub]
                );
            }
        }

        await client.query('COMMIT');
        return res.status(201).json({ message: "Registration successful!", user: newUserResult.rows[0] });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("SIGNUP DB ERROR:", err.message);
        return res.status(500).json({ message: "Database Error: " + err.message });
    } finally {
        client.release();
    }
});

// 3. CHECK BIOMETRIC LOCK STATUS
router.get("/check-lock/:usn", async (req, res) => {
    try {
        const result = await pool.query("SELECT device_token FROM users WHERE usn = $1", [req.params.usn]);
        if(result.rows.length > 0 && result.rows[0].device_token) {
            return res.json({ isLocked: true });
        }
        res.json({ isLocked: false });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;