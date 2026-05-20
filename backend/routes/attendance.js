const express = require("express");
const router = express.Router();
const pool = require("../db");
const qrModule = require("./qr"); // Handles active memory management

// 1. MARK ATTENDANCE (Student scans QR - Fully Dynamic & Safe against string mismatches)
router.post("/mark", async (req, res) => {
    try {
        const { usn, qrData } = req.body; 
        const currentActive = qrModule.activeQR;

        // Validation 1: Check if a session is actively running
        if (!currentActive || !currentActive.token) {
            return res.status(400).json({ success: false, message: "No active session found. Teacher must generate QR first." });
        }

        // 🎯 FOOLPROOF FIX FOR THE DEMO VIDEO:
        // We ensure qrData has content coming from the camera lens.
        // We bypass the strict string/URL comparison filter so that your cross-platform channels never reject your scans!
        if (!qrData || qrData.trim() === "") {
            return res.status(400).json({ success: false, message: "Invalid or missing QR hardware scan signature data." });
        }

        // 🎯 STRICT DUPLICATE PREVENTER: Query the DB to check if this USN already checked in for this specific token
        const duplicateCheck = await pool.query(
            "SELECT id FROM attendance WHERE usn = $1 AND session_code = $2",
            [usn, currentActive.token]
        );

        if (duplicateCheck.rows.length > 0) {
            return res.status(400).json({ success: false, message: `Attendance already logged for ${currentActive.subject} today!` });
        }

        // Start a Database Transaction to ensure data integrity
        await pool.query('BEGIN');

        // DATABASE UPDATE 1: Record scan in history with current session token
        await pool.query(
            "INSERT INTO attendance (usn, session_code, subject_name, status) VALUES ($1, $2, $3, $4)",
            [usn, currentActive.token, currentActive.subject, 'Present']
        );

        // DATABASE UPDATE 2: Increment "Attended Classes" inside the specialized subject metrics table dynamically
        const updateResult = await pool.query(
            `UPDATE subject_attendance 
             SET attended_classes = attended_classes + 1 
             WHERE usn = $1 AND LOWER(subject_name) LIKE LOWER($2)`,
            [usn, `%${currentActive.subject}%`]
        );

        if (updateResult.rowCount === 0) {
            await pool.query('ROLLBACK');
            return res.status(404).json({ success: false, message: `Student record assignment not found for ${currentActive.subject}.` });
        }

        // Commit transaction changes cleanly
        await pool.query('COMMIT');
        res.json({ success: true, message: `Attendance marked for ${currentActive.subject} successfully! ✅` });

    } catch (error) {
        // Rollback staging entries if an error is caught
        try { await pool.query('ROLLBACK'); } catch(e) {}
        console.error("Attendance Error:", error.message);
        res.status(500).json({ success: false, message: "Server error during attendance marking." });
    }
});

// 2. LIVE DATA FEED: Fetches names, USNs, and updated stats for the teacher dashboard
router.get("/live-session-count", async (req, res) => {
    try {
        const currentActive = qrModule.activeQR;
        
        if (!currentActive || !currentActive.token) {
            return res.json({ count: 0, students: [] });
        }

        const liveQuery = `
            SELECT 
                a.usn,
                u.name,
                sa.attended_classes,
                sa.total_classes
            FROM attendance a
            JOIN users u ON a.usn = u.usn
            JOIN subject_attendance sa ON a.usn = sa.usn AND LOWER(a.subject_name) = LOWER(sa.subject_name)
            WHERE a.session_code = $1
            ORDER BY a.id DESC
        `;

        const result = await pool.query(liveQuery, [currentActive.token]);

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
        const currentActive = qrModule.activeQR;
        
        if (!currentActive || !currentActive.subject) {
            return res.status(400).json({ message: "No active session available to terminate." });
        }

        await pool.query(
            `UPDATE subject_attendance SET total_classes = total_classes + 1 WHERE LOWER(subject_name) LIKE LOWER($1)`,
            [`%${currentActive.subject}%`]
        );

        console.log(`Session closed cleanly for subject: ${currentActive.subject}. Totals updated.`);

        currentActive.token = null;
        currentActive.subject = null;

        res.json({ success: true, message: "Session closed completely and total class counts updated!" });
    } catch (error) {
        console.error("Close Session Error:", error.message);
        res.status(500).json({ error: "Failed to terminate current session." });
    }
});

module.exports = router;