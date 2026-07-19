const express = require('express');
const router = express.Router();
const pool = require('../db'); 

// 1. SECURE MULTI-TENANT COMBINED LOGIN
router.post("/combined-login", async (req, res) => {
    const { usn, password, role, institutionId } = req.body;
    const targetTenant = institutionId || 'DR_AIT';
    try {
        const result = await pool.query("SELECT * FROM users WHERE usn = $1 AND role = $2 AND institution_id = $3", [usn, role.toLowerCase(), targetTenant]);
        if (result.rows.length === 0) return res.status(400).json({ message: "Account record not found." });
        const user = result.rows[0];
        if (user.password !== password) return res.status(400).json({ message: "Incorrect credentials." });
        return res.json({ success: true, usn: user.usn, name: user.name, role: user.role, subjectName: user.subject_name, institutionId: user.institution_id });
    } catch (err) { return res.status(500).json({ message: err.message }); }
});

// 2. SIGNUP WORKSPACE REGISTRY
router.post("/signup", async (req, res) => {
    const { usn, email, password, role, name, childUsn, subjectName, institutionId, phoneNumber } = req.body;
    const tenant = institutionId || 'DR_AIT';
    try {
        const userExists = await pool.query("SELECT * FROM users WHERE usn = $1 AND institution_id = $2", [usn, tenant]);
        if (userExists.rows.length > 0) return res.status(400).json({ message: "Identity vector already maps to a tenant record." });
        await pool.query(
            "INSERT INTO users (usn, email, password, role, name, child_usn, subject_name, institution_id, phone_number) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
            [usn, email, password, role.toLowerCase(), name || usn, childUsn || null, role.toLowerCase() === 'teacher' ? subjectName : null, tenant, phoneNumber || '+919876543210']
        );
        return res.status(201).json({ success: true });
    } catch (err) { return res.status(500).json({ message: err.message }); }
});

// 3. TEACHER REGISTER A NEW CLASS SESSION INSTANCE
router.post("/create-session", async (req, res) => {
    const { sessionCode, subjectName, institutionId } = req.body;
    const tenant = institutionId || 'DR_AIT';
    try {
        await pool.query("INSERT INTO class_sessions (session_code, subject_name, institution_id, created_at) VALUES ($1, $2, $3, NOW())", [sessionCode, subjectName || 'AI', tenant]);
        return res.status(200).json({ success: true });
    } catch (err) { return res.status(500).json({ message: err.message }); }
});

// 4. SUBMIT BIOMETRIC ATTENDANCE
router.post("/submit-attendance", async (req, res) => {
    const { studentId, subjectName, sessionCode, distance, latitude, longitude, institutionId } = req.body;
    const tenant = institutionId || 'DR_AIT';
    try {
        const sessionResult = await pool.query("SELECT * FROM class_sessions WHERE session_code = $1 AND institution_id = $2", [sessionCode, tenant]);
        if (sessionResult.rows.length === 0) return res.status(400).json({ message: "Invalid token context." });

        const session = sessionResult.rows[0];
        const tokenAgeInSeconds = (new Date() - new Date(session.created_at)) / 1000;
        if (tokenAgeInSeconds > 180.0) return res.status(400).json({ message: "Security Error: Session expired!" });

        const duplicateCheck = await pool.query("SELECT * FROM users_attendance WHERE student_id = $1 AND session_code = $2 AND institution_id = $3", [studentId, sessionCode, tenant]);
        if (duplicateCheck.rows.length > 0) return res.status(400).json({ message: "Attendance duplicate flagged." });

        let isProxySuspected = false;
        if (latitude && longitude) {
            if (Math.abs(parseFloat(latitude) - 12.9634) > 0.003 || Math.abs(parseFloat(longitude) - 77.5058) > 0.003) isProxySuspected = true;
        }

        const parsedDistance = parseFloat(distance) || 0.22;
        const distanceMatchCheck = await pool.query("SELECT * FROM users_attendance WHERE session_code = $1 AND CAST(distance AS NUMERIC) = CAST($2 AS NUMERIC) AND institution_id = $3", [sessionCode, parsedDistance, tenant]);
        if (distanceMatchCheck.rows.length > 0) isProxySuspected = true;

        const finalDistanceText = isProxySuspected ? `${parsedDistance}_PROXY` : `${parsedDistance}`;
        await pool.query("INSERT INTO users_attendance (student_id, subject_name, session_code, distance, latitude, longitude, institution_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())", [studentId, subjectName, sessionCode, finalDistanceText, latitude || null, longitude || null, tenant]);

        return res.status(200).json({ success: true, is_proxy: isProxySuspected });
    } catch (err) { return res.status(500).json({ message: err.message }); }
});

// 5. AUTOMATED LOCKDOWN COMPLIANCE COMMUNICATIONS BROKER
router.post("/end-session", async (req, res) => {
    const { sessionCode, subjectName, institutionId } = req.body;
    const tenant = institutionId || 'DR_AIT';
    const targetSubject = subjectName || 'AI';
    try {
        const allStudents = await pool.query("SELECT usn, name, phone_number FROM users WHERE role = 'student' AND institution_id = $1", [tenant]);
        const presentStudents = await pool.query("SELECT student_id FROM users_attendance WHERE session_code = $1 AND institution_id = $2", [sessionCode, tenant]);
        const presentUsns = presentStudents.rows.map(r => r.student_id.toUpperCase());

        const totalConductedResult = await pool.query("SELECT COUNT(*) as conducted FROM class_sessions WHERE subject_name = $1 AND institution_id = $2", [targetSubject, tenant]);
        const totalConducted = parseInt(totalConductedResult.rows[0].conducted) || 1;

        console.log(`\n🛑 [SESSION COMPLIANCE AUTOMATION LOG] Token: ${sessionCode}`);
        for (let student of allStudents.rows) {
            if (!presentUsns.includes(student.usn.toUpperCase())) {
                const studentAttendedResult = await pool.query("SELECT COUNT(*) as attended FROM users_attendance WHERE student_id = $1 AND subject_name = $2 AND institution_id = $3", [student.usn, targetSubject, tenant]);
                const totalAttended = parseInt(studentAttendedResult.rows[0].attended) || 0;
                const calculatedPercentage = Math.round((totalAttended / totalConducted) * 100);

                console.log(`📱 [ALERT BROADCAST] -> TO: ${student.name} & Parent | PHONE: ${student.phone_number || 'Linked'}`);
                console.log(`   📝 MESSAGE: "Absence warning for ${targetSubject}. Current metric is ${calculatedPercentage}%."`);
            }
        }
        return res.json({ success: true });
    } catch (err) { return res.status(500).json({ message: err.message }); }
});

// 6. STREAM REGISTRY DATA FEEDS
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
        if (sessionCode) { queryStr += " AND a.session_code = $2 "; params.push(sessionCode); }
        queryStr += " ORDER BY a.created_at DESC";
        const result = await pool.query(queryStr, params);
        const processedRows = result.rows.map(row => {
            const hasProxyFlag = row.distance.toString().includes('_PROXY');
            return { ...row, distance: hasProxyFlag ? row.distance.split('_')[0] + "m" : row.distance + "m", is_proxy: hasProxyFlag };
        });
        return res.json(processedRows);
    } catch (err) { return res.status(500).json({ error: err.message }); }
});

// 7. 🎯 FIXED ALL-SEMESTER DATA-DRIVEN METRICS PERF ENDPOINT
router.get("/student-subject-metrics", async (req, res) => {
    const { studentId, institutionId } = req.query;
    const tenant = institutionId || 'DR_AIT';
    try {
        const totalConducted = await pool.query("SELECT subject_name, COUNT(*) as conducted FROM class_sessions WHERE institution_id = $1 GROUP BY subject_name", [tenant]);
        const totalAttended = await pool.query("SELECT subject_name, COUNT(*) as attended FROM users_attendance WHERE student_id = $1 AND institution_id = $2 GROUP BY subject_name", [studentId, tenant]);
        const logsHistory = await pool.query("SELECT subject_name, created_at FROM users_attendance WHERE student_id = $1 AND institution_id = $2 ORDER BY created_at DESC", [studentId, tenant]);
        
        // Fetch all registered rows inside our academic record index database
        const realMarksResult = await pool.query("SELECT * FROM student_marks WHERE student_id = $1 AND institution_id = $2", [studentId, tenant]);

        let aiPredictions = [];
        realMarksResult.rows.forEach(markRow => {
            const condObj = totalConducted.rows.find(c => c.subject_name.toUpperCase() === markRow.subject_name.toUpperCase()) || { conducted: 0 };
            const attObj = totalAttended.rows.find(a => a.subject_name.toUpperCase() === markRow.subject_name.toUpperCase()) || { attended: 0 };
            
            const conductedCount = parseInt(condObj.conducted) || 0;
            const attendedCount = parseInt(attObj.attended) || 0;
            const absentCount = conductedCount - attendedCount;
            
            const currentRatio = conductedCount > 0 ? (attendedCount / conductedCount) : 1.0;
            let predictedFinalRatio = Math.round(currentRatio * 100);
            
            if (conductedCount > 1 && attendedCount < conductedCount) predictedFinalRatio = Math.max(45, predictedFinalRatio - 5);
            const isShortage = conductedCount > 0 ? (predictedFinalRatio < 75) : false;

            aiPredictions.push({
                subject: markRow.subject_name,
                subject_code: markRow.subject_code,
                conducted: conductedCount,
                attended: attendedCount,
                absent: absentCount,
                estimated_final: conductedCount > 0 ? predictedFinalRatio + "%" : "100%",
                risk_status: isShortage ? "⚠️ HIGH RISK SHORTAGE" : "✅ SAFE ZONE",
                cie1: markRow.cie1,
                cie2: markRow.cie2,
                cie3: markRow.cie3,
                see: markRow.see
            });
        });
        return res.json({ conducted: totalConducted.rows, attended: totalAttended.rows, history: logsHistory.rows, ai_predictions: aiPredictions });
    } catch (err) { return res.status(500).json({ error: err.message }); }
});

// 8. DISTINCT HISTORICAL SESSIONS
router.get("/distinct-sessions", async (req, res) => {
    const { subject, institutionId } = req.query;
    const tenant = institutionId || 'DR_AIT';
    try {
        const result = await pool.query("SELECT session_code, created_at as session_date FROM class_sessions WHERE subject_name = $1 AND institution_id = $2 ORDER BY created_at DESC", [subject || 'AI', tenant]);
        return res.json(result.rows);
    } catch (err) { return res.status(500).json({ error: err.message }); }
});

// 9. STUDENT MARKS GENERAL ROSTER
router.get("/student-marks-roster", async (req, res) => {
    const { institutionId } = req.query;
    const tenant = institutionId || 'DR_AIT';
    try {
        const result = await pool.query(`
            SELECT u.name, m.student_id AS usn, u.phone_number, m.subject_code, m.subject_name, m.cie1, m.cie2, m.cie3, m.see
            FROM student_marks m
            JOIN users u ON m.student_id = u.usn
            WHERE m.institution_id = $1
            ORDER BY u.name ASC, m.subject_code ASC
        `, [tenant]);
        return res.json(result.rows);
    } catch (err) { return res.status(500).json({ error: err.message }); }
});

module.exports = router;