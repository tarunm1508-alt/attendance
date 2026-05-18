const express = require("express");
const router = express.Router();
const pool = require("../db");

// 1. LOGIN ROUTE
router.post("/login", async (req, res) => {
    try {
        const { usn, password, role } = req.body;

        console.log(`Login Attempt: USN=${usn}, Role=${role}`);

        const userQuery = await pool.query(
            "SELECT * FROM users WHERE usn = $1 AND role = $2",
            [usn, role]
        );

        if (userQuery.rows.length === 0) {
            return res.status(404).json({ message: "User not found with this role." });
        }

        const user = userQuery.rows[0];

        if (user.password !== password) {
            return res.status(401).json({ message: "Invalid credentials." });
        }

        return res.status(200).json({
            message: "Login successful",
            user: {
                usn: user.usn,
                name: user.name,
                role: user.role
            }
        });

    } catch (err) {
        console.error("Login Error:", err.message);
        return res.status(500).json({ message: "Server error during login." });
    }
});

// 2. SIGNUP ROUTE
router.post("/register", async (req, res) => {
    // We use a separate client for database transactions
    const client = await pool.connect();
    
    try {
        const { usn, name, email, password, role, child_usn } = req.body;

        // Start Database Transaction
        await client.query('BEGIN');

        // SECURITY RULE 1: Explicitly check if the email address is already registered
        const emailExists = await client.query("SELECT * FROM users WHERE email = $1", [email]);
        if (emailExists.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: "This email address is already registered." });
        }

        // SECURITY RULE 2: Check if USN/Employee ID exists
        const userExists = await client.query("SELECT * FROM users WHERE usn = $1", [usn]);
        if (userExists.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: "This USN or User ID is already taken." });
        }

        // SECURITY RULE 3: If registering as a parent, verify if the specified Child USN actually exists
        if (role === 'parent') {
            if (!child_usn) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: "Parent registration requires a child's USN." });
            }

            const childExists = await client.query("SELECT * FROM users WHERE usn = $1 AND role = 'student'", [child_usn]);
            if (childExists.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ message: `The specified Child USN (${child_usn}) does not exist in the student database.` });
            }
        }

        // 1. Insert into users table (Saves your new custom fields dynamically)
        const newUserResult = await client.query(
            "INSERT INTO users (usn, name, email, password, role, child_usn) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
            [usn, name, email, password, role.toLowerCase(), (role === 'parent' ? child_usn : null)]       
        );

        // 2. If student, create attendance rows for each subject
        if (role === 'student') {
            const subjects = ['DBMS', 'AI', 'ADA', 'MERN', 'CDN'];
            for (let sub of subjects) {
                await client.query(
                    "INSERT INTO subject_attendance (usn, subject_name, attended_classes, total_classes) VALUES ($1, $2, 0, 0)",
                    [usn, sub]
                );
            }
            console.log(`Subjects initialized for student: ${usn}`);
        }

        // Commit (Save) everything cleanly to the DB
        await client.query('COMMIT');

        return res.status(201).json({ 
            message: "Registration successful!", 
            user: newUserResult.rows[0] 
        });

    } catch (err) {
        // Undo active staging sequences if any block fails
        await client.query('ROLLBACK');
        console.error("SIGNUP DB ERROR:", err.message);

        if (err.code === '23505') {
            return res.status(400).json({ message: "Unique constraint validation failed. Use different details." });
        }

        return res.status(500).json({ message: "Database Error: " + err.message });
    } finally {
        // Release client back to pool configuration safely
        client.release();
    }
});

module.exports = router;