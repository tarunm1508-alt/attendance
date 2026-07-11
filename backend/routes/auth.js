const express = require('express');
const router = express.Router();
const pool = require('../db'); 

// ==========================================================================
// 1. MULTI-TENANT SECURE COMBINED LOGIN
// ==========================================================================
router.post("/combined-login", async (req, res) => {
    const { usn, password, role, institutionId } = req.body;
    const targetTenant = institutionId || 'DR_AIT';
    try {
        const result = await pool.query(
            "SELECT * FROM users WHERE usn = $1 AND role = $2 AND institution_id = $3", 
            [usn, role.toLowerCase(), targetTenant]
        );
        if (result.rows.length === 0) return res.status(400).json({ message: "Account record not found inside this tenant pool." });
        
        const user = result.rows[0];
        if (user.password !== password) return res.status(400).json({ message: "Incorrect account credentials." });
        
        return res.json({ 
            success: true, 
            usn: user.usn, 
            name: user.name, 
            role: user.role, 
            subjectName: user.subject_name,
            institutionId: user.institution_id 
        });
    } catch (err) { return res.status(500).json({ message: err.message }); }
});

// ==========================================================================
// 2. BIOMETRIC ATTENDANCE PROCESSING WITH MULTI-TENANCY & FRAUD CORES
// ==========================================================================
router.post("/submit-attendance", async (req, res) => {
    const { studentId, subjectName, sessionCode, distance, latitude, longitude, institutionId } = req.body;
    const tenant = institutionId || 'DR_AIT';
    try {
        const sessionResult = await pool.query(
            "SELECT * FROM class_sessions WHERE session_code = $1 AND institution_id = $2", 
            [sessionCode, tenant]
        );
        if (sessionResult.rows.length === 0) {
            return res.status(400).json({ message: "Invalid token context for this institution." });
        }

        const session = sessionResult.rows[0];
        const tokenAgeInSeconds = (new Date() - new Date(session.created_at)) / 1000;

        if (tokenAgeInSeconds > 12.0) {
            return res.status(400).json({ message: "Security Error: Rolling QR token expired!" });
        }

        const duplicateCheck = await pool.query(
            "SELECT * FROM users_attendance WHERE student_id = $1 AND session_code = $2 AND institution_id = $3",
            [studentId, sessionCode, tenant]
        );
        if (duplicateCheck.rows.length > 0) {
            return res.status(400).json({ message: "Attendance duplicate flagged." });
        }

        // GPS Geofence Check (Dr. AIT Campus: 12.9634, 77.5058)
        let isProxySuspected = false;
        if (latitude && longitude) {
            if (Math.abs(parseFloat(latitude) - 12.9634) > 0.003 || Math.abs(parseFloat(longitude) - 77.5058) > 0.003) {
                isProxySuspected = true;
            }
        }

        const finalDistanceText = isProxySuspected ? `${distance || '0.22'}_PROXY` : `${distance || '0.22'}`;

        await pool.query(
            "INSERT INTO users_attendance (student_id, subject_name, session_code, distance, latitude, longitude, institution_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())",
            [studentId, subjectName, sessionCode, finalDistanceText, latitude || null, longitude || null, tenant]
        );

        return res.status(200).json({ success: true, is_proxy: isProxySuspected, message: "Telemetry processed successfully." });
    } catch (err) { return res.status(500).json({ message: err.message }); }
});

// ==========================================================================
// 3. STUDENT SUBJECT PERFORMANCE AND AI TRAJECTORY BENTO ENGINE
// ==========================================================================
router.get("/student-subject-metrics", async (req, res) => {
    const { studentId, institutionId } = req.query;
    const tenant = institutionId || 'DR_AIT';
    try {
        const totalConducted = await pool.query("SELECT subject_name, COUNT(*) as conducted FROM class_sessions WHERE institution_id = $1 GROUP BY subject_name", [tenant]);
        const totalAttended = await pool.query("SELECT subject_name, COUNT(*) as attended FROM users_attendance WHERE student_id = $1 AND institution_id = $2 GROUP BY subject_name", [studentId, tenant]);
        const logsHistory = await pool.query("SELECT subject_name, created_at FROM users_attendance WHERE student_id = $1 AND institution_id = $2 ORDER BY created_at DESC", [studentId, tenant]);

        let aiPredictions = [];
        totalConducted.rows.forEach(cond => {
            const attObj = totalAttended.rows.find(a => a.subject_name === cond.subject_name) || { attended: 0 };
            const currentRatio = cond.conducted > 0 ? (attObj.attended / cond.conducted) : 1.0;
            let predictedFinalRatio = Math.round(currentRatio * 100);
            if (cond.conducted > 1 && attObj.attended < cond.conducted) {
                predictedFinalRatio = Math.max(45, predictedFinalRatio - 5); 
            }
            aiPredictions.push({
                subject: cond.subject_name,
                estimated_final: predictedFinalRatio + "%",
                risk_status: predictedFinalRatio < 75 ? "⚠️ HIGH RISK" : "✅ SAFE ZONE"
            });
        });

        return res.json({ conducted: totalConducted.rows, attended: totalAttended.rows, history: logsHistory.rows, ai_predictions: aiPredictions });
    } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ==========================================================================
// 4. NEW: HOD BRANCH EXECUTIVE INSIGHT OVERVIEW ENDPOINT
// ==========================================================================
router.get("/hod-tenant-analytics", async (req, res) => {
    const { institutionId } = req.query;
    const tenant = institutionId || 'DR_AIT';
    try {
        const totalStudents = await pool.query("SELECT COUNT(*) as counts FROM users WHERE role = 'student' AND institution_id = $1", [tenant]);
        const totalSessions = await pool.query("SELECT COUNT(*) as counts FROM class_sessions WHERE institution_id = $1", [tenant]);
        const proxyLogs = await pool.query("SELECT COUNT(*) as counts FROM users_attendance WHERE distance LIKE '%_PROXY%' AND institution_id = $1", [tenant]);
        
        return res.json({
            studentsCount: totalStudents.rows[0].counts,
            sessionsCount: totalSessions.rows[0].counts,
            fraudFlagsCount: proxyLogs.rows[0].counts
        });
    } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ==========================================================================
// 5. LIVE RESTRY DATA FEEDS
// ==========================================================================
router.get("/attendance-records", async (req, res) => {
    const { sessionCode, institutionId } = req.query;
    const tenant = institutionId || 'DR_AIT';
    try {
        let queryStr = `
            SELECT a.id, a.student_id, a.session_code, a.distance, a.created_at, a.subject_name, u.name AS student_full_name
            FROM users_attendance a
            LEFT JOIN users u ON a.student_id = u.usn
            WHERE a.institution_id = $1
        `;
        const params = [tenant];
        if (sessionCode) {
            queryStr += " AND a.session_code = $2 ";
            params.push(sessionCode);
        }
        queryStr += " ORDER BY a.created_at DESC";
        const result = await pool.query(queryStr, params);

        const processedRows = result.rows.map(row => {
            const hasProxyFlag = row.distance.toString().includes('_PROXY');
            return { ...row, distance: hasProxyFlag ? row.distance.split('_')[0] + "m" : row.distance + "m", is_proxy: hasProxyFlag };
        });
        return res.json(processedRows);
    } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.get("/distinct-sessions", async (req, res) => {
    const { subject, institutionId } = req.query;
    const tenant = institutionId || 'DR_AIT';
    try {
        const result = await pool.query("SELECT session_code, created_at as session_date FROM class_sessions WHERE subject_name = $1 AND institution_id = $2 ORDER BY created_at DESC", [subject || 'AI', tenant]);
        return res.json(result.rows);
    } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.get("/student-marks-roster", async (req, res) => {
    try {
        const result = await pool.query("SELECT usn, name, email FROM users WHERE role = 'student' ORDER BY name ASC");
        return res.json(result.rows);
    } catch (err) { return res.status(500).json({ error: err.message }); }
});

module.exports = router;