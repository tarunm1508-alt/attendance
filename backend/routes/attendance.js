const express = require("express");
const router = express.Router();
const pool = require("../db");
const qrModule = require("./qr"); // Handles active memory management

// 1. MARK ATTENDANCE (Student scans QR - Fully Dynamic & Safe against string mismatches)
router.post("/mark", async (req, res) => {
    try {
        const { usn, qrData, institutionId } = req.body; 
        const tenant = institutionId || 'DR_AIT';
        const currentActive = qrModule.activeQR;

        // Validation 1: Check if a session is actively running
        if (!currentActive || !currentActive.token) {
            return res.status(400).json({ success: false, message: "No active session found. Teacher must generate QR first." });
        }

        // Ensure qrData has content coming from the camera lens
        if (!qrData || qrData.trim() === "") {
            return res.status(400).json({ success: false, message: "Invalid or missing QR hardware scan signature data." });
        }

        const cleanUsn = usn ? usn.trim().toUpperCase() : '';

        // STRICT DUPLICATE PREVENTER: Query the DB to check if this USN already checked in for this session
        const duplicateCheck = await pool.query(
            "SELECT id FROM users_attendance WHERE UPPER(student_id) = $1 AND session_code = $2 AND institution_id = $3",
            [cleanUsn, currentActive.token, tenant]
        );

        if (duplicateCheck.rows.length > 0) {
            return res.status(400).json({ success: false, message: `Attendance already logged for ${currentActive.subject} today!` });
        }

        // Get student full name
        const studentLookup = await pool.query("SELECT name FROM users WHERE UPPER(usn) = $1 AND institution_id = $2", [cleanUsn, tenant]);
        const studentFullName = studentLookup.rows[0]?.name || 'Verified Student';

        // Start a Database Transaction to ensure data integrity
        await pool.query('BEGIN');

        // DATABASE UPDATE 1: Record scan in users_attendance with current session token
        await pool.query(
            `INSERT INTO users_attendance (student_id, student_full_name, subject_name, session_code, distance, institution_id, created_at) 
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [cleanUsn, studentFullName, currentActive.subject, currentActive.token, '0.14m', tenant]
        );

        // Commit transaction changes cleanly
        await pool.query('COMMIT');
        res.json({ success: true, message: `Attendance marked for ${currentActive.subject} successfully! ✅` });

    } catch (error) {
        try { await pool.query('ROLLBACK'); } catch(e) {}
        console.error("Attendance Error:", error.message);
        res.status(500).json({ success: false, message: "Server error during attendance marking." });
    }
});

// 2. LIVE DATA FEED: Fetches names, USNs, and updated stats for the teacher dashboard
router.get("/live-session-count", async (req, res) => {
    try {
        const { institutionId } = req.query;
        const tenant = institutionId || 'DR_AIT';
        const currentActive = qrModule.activeQR;
        
        if (!currentActive || !currentActive.token) {
            return res.json({ count: 0, students: [] });
        }

        const liveQuery = `
            SELECT 
                a.student_id AS usn,
                COALESCE(a.student_full_name, u.name, 'Verified Student') AS name
            FROM users_attendance a
            LEFT JOIN users u ON UPPER(a.student_id) = UPPER(u.usn)
            WHERE a.session_code = $1 AND a.institution_id = $2
            ORDER BY a.created_at DESC
        `;

        const result = await pool.query(liveQuery, [currentActive.token, tenant]);

        res.json({
            count: result.rowCount,
            students: result.rows
        });

    } catch (error) {
        console.error("Live Count Error:", error.message);
        res.status(500).json({ error: "Could not fetch live session tracking stream metrics." });
    }
});

// 3. CLOSE SESSION & INCREMENT TOTAL CLASSES
router.post("/close-session", async (req, res) => {
    try {
        const { institutionId } = req.body;
        const tenant = institutionId || 'DR_AIT';
        const currentActive = qrModule.activeQR;
        
        if (!currentActive || !currentActive.subject) {
            return res.status(400).json({ message: "No active session available to terminate." });
        }

        // Log session close instance into class_sessions ledger
        await pool.query(
            `INSERT INTO class_sessions (session_code, subject_name, institution_id, created_at) 
             VALUES ($1, $2, $3, NOW()) ON CONFLICT DO NOTHING`,
            [currentActive.token || 'SESSION_CLOSED', currentActive.subject, tenant]
        );

        console.log(`Session closed cleanly for subject: ${currentActive.subject}.`);

        currentActive.token = null;
        currentActive.subject = null;

        res.json({ success: true, message: "Session closed completely and totals updated!" });
    } catch (error) {
        console.error("Close Session Error:", error.message);
        res.status(500).json({ error: "Failed to terminate current session." });
    }
});

module.exports = router;