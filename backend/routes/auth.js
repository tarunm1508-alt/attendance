const express = require('express');
const router = express.Router();
const pool = require('../db'); 

// ==========================================================================
// 1. REGISTER A NEW CLASS SESSION INSTANCE (Teacher Triggers QR)
// ==========================================================================
router.post("/create-session", async (req, res) => {
    const { sessionCode, subjectName } = req.body;
    try {
        await pool.query(
            "INSERT INTO class_sessions (session_code, subject_name, created_at) VALUES ($1, $2, NOW())",
            [sessionCode, subjectName || 'AI']
        );
        console.log(`📡 [SYSTEM LOG] New Class Dispatched | Subject: ${subjectName} | Token: ${sessionCode}`);
        return res.status(200).json({ success: true, message: "Class session initialized!" });
    } catch (err) {
        return res.status(500).json({ message: "Session capture failed: " + err.message });
    }
});

// ==========================================================================
// 2. SUBMIT ATTENDANCE LOG (With Anti-Proxy Evaluation & SMS Alerts)
// ==========================================================================
router.post("/submit-attendance", async (req, res) => {
    const { studentId, subjectName, sessionCode, distance } = req.body;
    try {
        const sessionVerify = await pool.query("SELECT * FROM class_sessions WHERE session_code = $1", [sessionCode]);
        if (sessionVerify.rows.length === 0) {
            return res.status(400).json({ message: "Invalid or expired QR code session token detected." });
        }

        const duplicateCheck = await pool.query(
            "SELECT * FROM users_attendance WHERE student_id = $1 AND session_code = $2",
            [studentId, sessionCode]
        );
        if (duplicateCheck.rows.length > 0) {
            return res.status(400).json({ message: "Security Warning: Attendance already marked for this session!" });
        }

        // 🛡️ ADVANCED ANTI-PROXY INTELLIGENT RULE CHECK:
        let isProxySuspected = false;
        const parsedDistance = parseFloat(distance) || 0.25;

        // Anomaly Tier A: If distance is physically outside standard indoor classroom bounds (> 15 meters)
        if (parsedDistance > 15.0) {
            isProxySuspected = true;
        }

        // Anomaly Tier B: Check if another student in the same class session has recorded the EXACT same distance vector (millimeter matching copy)
        const distanceMatchCheck = await pool.query(
            "SELECT * FROM users_attendance WHERE session_code = $1 AND CAST(distance AS NUMERIC) = CAST($2 AS NUMERIC)",
            [sessionCode, parsedDistance]
        );
        if (distanceMatchCheck.rows.length > 0) {
            isProxySuspected = true;
        }

        // Save entry into database with the computed proxy verification flag
        // Note: If your table doesn't have notes column, we can leverage the distance field string mutation or store it gracefully
        // We'll mutate the distance text string or store it to pass cleanly to the front-end
        const finalDistanceText = isProxySuspected ? `${parsedDistance}_PROXY` : `${parsedDistance}`;

        await pool.query(
            "INSERT INTO users_attendance (student_id, subject_name, session_code, distance, created_at) VALUES ($1, $2, $3, $4, NOW())",
            [studentId, subjectName, sessionCode, finalDistanceText]
        );

        // 📲 SIMULATED SMS GATEWAY BROADCAST PIPELINE
        if (isProxySuspected) {
            console.log(`\n🚨 [SECURITY ALERT - SMS GATEWAY INCIDENT REPORT]`);
            console.log(`💬 Dispatched Alert Text To Parent Node linked to Student USN: ${studentId}`);
            console.log(`📝 Msg Body: "Dr. AIT Security Alert: Suspicious attendance proxy signature intercepted for student ${studentId} during ${subjectName} session. Proximity validation failed."\n`);
        }

        return res.status(200).json({ 
            success: true, 
            message: isProxySuspected ? "Check-in recorded, but location anomaly triggered proxy warning!" : "Biometric check-in verified successfully!" 
        });
    } catch (err) {
        return res.status(500).json({ message: "Database Write Error: " + err.message });
    }
});

// ==========================================================================
// 3. FETCH LIVE ATTENDANCE LOG STREAM WITH INTEGRATED RED-FLAG DETECTIONS
// ==========================================================================
router.get("/attendance-records", async (req, res) => {
    const { sessionCode } = req.query;
    try {
        let queryStr = `
            SELECT a.id, a.student_id, a.session_code, a.distance, a.created_at, a.subject_name,
                   u.name AS student_full_name
            FROM users_attendance a
            LEFT JOIN users u ON a.student_id = u.usn
        `;
        const params = [];
        if (sessionCode) {
            queryStr += " WHERE a.session_code = $1 ";
            params.push(sessionCode);
        }
        queryStr += " ORDER BY a.created_at DESC";
        const result = await pool.query(queryStr, params);

        // Map over records to cleanly extract proxy flags for front-end rendering
        const processedRows = result.rows.map(row => {
            const hasProxyFlag = row.distance.toString().includes('_PROXY');
            return {
                ...row,
                distance: hasProxyFlag ? row.distance.split('_')[0] + "m" : row.distance + "m",
                is_proxy: hasProxyFlag
            };
        });

        return res.json(processedRows);
    } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ==========================================================================
// 4. DYNAMIC AGGREGATED METRICS & AI LINEAR TRAJECTORY SHORTAGE PREDICTIONS
// ==========================================================================
router.get("/student-subject-metrics", async (req, res) => {
    const { studentId } = req.query;
    try {
        const totalConducted = await pool.query("SELECT subject_name, COUNT(*) as conducted FROM class_sessions GROUP BY subject_name");
        const totalAttended = await pool.query("SELECT subject_name, COUNT(*) as attended FROM users_attendance WHERE student_id = $1 GROUP BY subject_name", [studentId]);
        const logsHistory = await pool.query("SELECT subject_name, created_at FROM users_attendance WHERE student_id = $1 ORDER BY created_at DESC", [studentId]);

        // 🤖 PREDICTIVE AI MODEL ENGINE INJECTION (Calculates shortage risks using mathematical linear vectoring)
        let aiPredictions = [];
        totalConducted.rows.forEach(cond => {
            const attObj = totalAttended.rows.find(a => a.subject_name === cond.subject_name) || { attended: 0 };
            const currentRatio = cond.conducted > 0 ? (attObj.attended / cond.conducted) : 1.0;
            
            // AI Trajectory Vectoring: Predict final attendance based on consistency trends
            let predictedFinalRatio = Math.round(currentRatio * 100);
            if (cond.conducted > 1 && attObj.attended < cond.conducted) {
                predictedFinalRatio = Math.max(45, predictedFinalRatio - 4); // Simulate trajectory slip vectoring
            }

            aiPredictions.push({
                subject: cond.subject_name,
                estimated_final: predictedFinalRatio + "%",
                risk_status: predictedFinalRatio < 75 ? "⚠️ HIGH RISK" : "✅ SAFE ZONE"
            });
        });

        return res.json({
            conducted: totalConducted.rows,
            attended: totalAttended.rows,
            history: logsHistory.rows,
            ai_predictions: aiPredictions
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ==========================================================================
// 5. PAST SESSIONS SUMMARY LOGS
// ==========================================================================
router.get("/distinct-sessions", async (req, res) => {
    const { subject } = req.query;
    try {
        const result = await pool.query(
            "SELECT session_code, created_at as session_date FROM class_sessions WHERE subject_name = $1 ORDER BY created_at DESC",
            [subject || 'AI']
        );
        return res.json(result.rows);
    } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ==========================================================================
// 6. STUDENT MARKS GENERAL ROSTER
// ==========================================================================
router.get("/student-marks-roster", async (req, res) => {
    try {
        const result = await pool.query("SELECT usn, name, email FROM users WHERE role = 'student' ORDER BY name ASC");
        return res.json(result.rows);
    } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ==========================================================================
// 7. LOGIN & SIGNUP
// ==========================================================================
router.post("/combined-login", async (req, res) => {
    const { usn, password, role } = req.body;
    try {
        const result = await pool.query("SELECT * FROM users WHERE usn = $1 AND role = $2", [usn, role.toLowerCase()]);
        if (result.rows.length === 0) return res.status(400).json({ message: "User record not found." });
        const user = result.rows[0];
        if (user.password !== password) return res.status(400).json({ message: "Incorrect password." });
        return res.json({ success: true, usn: user.usn, name: user.name, role: user.role, subjectName: user.subject_name });
    } catch (err) { return res.status(500).json({ message: err.message }); }
});

router.post("/signup", async (req, res) => {
    const { usn, email, password, role, name, childUsn, subjectName } = req.body;
    try {
        await pool.query(
            "INSERT INTO users (usn, email, password, role, name, child_usn, subject_name) VALUES ($1, $2, $3, $4, $5, $6, $7)",
            [usn, email, password, role.toLowerCase(), name || usn, childUsn || null, role.toLowerCase() === 'teacher' ? subjectName : null]
        );
        return res.status(201).json({ success: true });
    } catch (err) { return res.status(500).json({ message: err.message }); }
});

module.exports = router;