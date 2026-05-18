const express = require("express");
const router = express.Router();
const pool = require("../db");
const qrModule = require("./qr"); // Handles active memory management

// 1. MARK ATTENDANCE (Student scans QR)
router.post("/mark", async (req, res) => {
    try {
        const { usn, subject } = req.body;
        const currentActive = qrModule.activeQR;

        // Validation: Check if a session is actively running
        if (!currentActive || !currentActive.token) {
            return res.status(400).json({ success: false, message: "No active session found. Teacher must generate QR first." });
        }

        // Logic check: Ensure student is scanning the right subject QR
        if (subject !== currentActive.subject) {
             return res.status(400).json({ success: false, message: "Subject mismatch. Please scan the correct QR code." });
        }

        // Start a Database Transaction to ensure data integrity
        await pool.query('BEGIN');

        // DATABASE UPDATE 1: Record scan in history with current session token
        await pool.query(
            "INSERT INTO attendance (usn, session_code, subject_name, status) VALUES ($1, $2, $3, $4)",
            [usn, currentActive.token, currentActive.subject, 'Present']
        );

        // DATABASE UPDATE 2: Increment "Attended Classes" inside the specialized subject metrics table
        const updateResult = await pool.query(
            `UPDATE subject_attendance 
             SET attended_classes = attended_classes + 1 
             WHERE usn = $1 AND subject_name = $2`,
            [usn, currentActive.subject]
        );

        if (updateResult.rowCount === 0) {
            await pool.query('ROLLBACK');
            return res.status(404).json({ success: false, message: "Student record assignment not found for this subject." });
        }

        // Commit transaction changes cleanly
        await pool.query('COMMIT');
        res.json({ success: true, message: `Attendance marked for ${currentActive.subject} ✅` });

    } catch (error) {
        // Rollback staging entries if an error is caught
        await pool.query('ROLLBACK');
        console.error("Attendance Error:", error.message);
        
        // Handle unique constraint violation (if student tries to scan twice)
        if (error.code === '23505') {
            return res.status(400).json({ success: false, message: "Attendance already marked for this session!" });
        }
        res.status(500).json({ success: false, message: "Server error during attendance marking." });
    }
});

// 2. LIVE DATA FEED: Fetches names, USNs, and updated stats for the teacher dashboard
router.get("/live-session-count", async (req, res) => {
    try {
        const currentActive = qrModule.activeQR;
        
        // If no QR session is currently active, return an empty array format safely
        if (!currentActive || !currentActive.token) {
            return res.json({ count: 0, students: [] });
        }

        // POWERFUL SQL JOIN: Fetches USN, Name, and updated class numbers in 1 query
        const liveQuery = `
            SELECT 
                a.usn,
                u.name,
                sa.attended_classes,
                sa.total_classes
            FROM attendance a
            JOIN users u ON a.usn = u.usn
            JOIN subject_attendance sa ON a.usn = sa.usn AND a.subject_name = sa.subject_name
            WHERE a.session_code = $1
            ORDER BY a.id DESC
        `;

        const result = await pool.query(liveQuery, [currentActive.token]);

        res.json({
            count: result.rowCount,
            students: result.rows // Returns full object list [{usn, name, attended_classes, total_classes}]
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

        // Update "Total Classes" for EVERY student registered in this specific course module
        await pool.query(
            `UPDATE subject_attendance SET total_classes = total_classes + 1 WHERE subject_name = $1`,
            [currentActive.subject]
        );

        console.log(`Session closed cleanly for subject: ${currentActive.subject}. Totals updated.`);

        // Clear active session runtime memory objects
        currentActive.token = null;
        currentActive.subject = null;

        res.json({ success: true, message: "Session closed completely and total class counts updated!" });
    } catch (error) {
        console.error("Close Session Error:", error.message);
        res.status(500).json({ error: "Failed to terminate current session." });
    }
});

module.exports = router;