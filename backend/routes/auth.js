const express = require('express');
const router = express.Router();
const pool = require('../db'); 
const crypto = require('crypto');

// 0. INITIATE LOGIN CHALLENGE & DEVICE BINDING CHECK
router.post("/login-challenge", async (req, res) => {
    const { usn, role, deviceFingerprint, institutionId } = req.body;
    const targetTenant = institutionId || 'DR_AIT';
    const cleanRole = (role || 'student').toLowerCase().trim();

    try {
        const result = await pool.query(
            `SELECT usn, name, role, password, device_fingerprint, biometric_enabled 
             FROM users 
             WHERE UPPER(usn) = UPPER($1) 
               AND (
                   LOWER(TRIM(role)) = LOWER(TRIM($2)) 
                   OR ($2 IN ('hod', 'teacher') AND LOWER(TRIM(role)) IN ('hod', 'teacher'))
               )
               AND COALESCE(institution_id, 'DR_AIT') ILIKE $3`,
            [usn.trim(), cleanRole, targetTenant]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Account record not found." });
        }

        const user = result.rows[0];
        const challenge = crypto.randomBytes(32).toString('base64url');

        return res.json({
            success: true,
            challenge: challenge,
            biometricEnabled: user.biometric_enabled,
            userName: user.name
        });

    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// 1. SECURE COMBINED LOGIN (With Strict Parent-Child Link Validation & Staff Role Flexibility)
router.post("/combined-login", async (req, res) => {
    const { usn, password, role, deviceFingerprint, institutionId, childUsn } = req.body;
    const targetTenant = institutionId || 'DR_AIT';
    const cleanRole = (role || 'student').toLowerCase().trim();

    try {
        const result = await pool.query(
            `SELECT * FROM users 
             WHERE UPPER(usn) = UPPER($1) 
               AND (
                   LOWER(TRIM(role)) = LOWER(TRIM($2)) 
                   OR ($2 IN ('hod', 'teacher') AND LOWER(TRIM(role)) IN ('hod', 'teacher'))
               )
               AND COALESCE(institution_id, 'DR_AIT') ILIKE $3`,
            [usn.trim(), cleanRole, targetTenant]
        );

        if (result.rows.length === 0) return res.status(400).json({ success: false, message: "Account record not found." });
        
        const user = result.rows[0];
        if (user.password !== password) return res.status(400).json({ success: false, message: "Incorrect credentials." });
        
        // PARENT LINK VALIDATION: Ensure the entered child USN matches the registered ward
        if (cleanRole === 'parent' && childUsn) {
            if (user.child_usn && user.child_usn.toUpperCase() !== childUsn.trim().toUpperCase()) {
                return res.status(400).json({ 
                    success: false, 
                    message: "⚠️ Incorrect student USN. This USN does not match your registered ward." 
                });
            }
        }

        // STRICT PROXY LOCKDOWN FOR STUDENTS:
        if (user.role.toLowerCase() === 'student') {
            if (!user.device_fingerprint && deviceFingerprint) {
                // First-time login: bind the device permanently
                await pool.query("UPDATE users SET device_fingerprint = $1 WHERE UPPER(usn) = UPPER($2)", [deviceFingerprint, user.usn]);
            } else if (user.device_fingerprint && deviceFingerprint && user.device_fingerprint !== deviceFingerprint) {
                // Block login if attempted from a different device fingerprint
                return res.status(403).json({ 
                    success: false, 
                    message: "⛔ PROXY BLOCKED: This account is permanently locked to a different smartphone. You cannot log in from a friend's device." 
                });
            }
        }

        return res.json({ 
            success: true, 
            usn: user.usn, 
            name: user.name, 
            role: user.role, 
            subjectName: user.subject_name, 
            branch: user.branch || 'AIML',
            institutionId: user.institution_id,
            childUsn: user.child_usn
        });
    } catch (err) { return res.status(500).json({ message: err.message }); }
});

// 2. SIGNUP WORKSPACE REGISTRY (Binds Device Token)
router.post("/signup", async (req, res) => {
    const { 
        usn, email, password, role, name, childUsn, subjectName, 
        branch, institutionId, phoneNumber, deviceFingerprint 
    } = req.body;

    const tenant = institutionId || 'DR_AIT';
    const cleanRole = (role || 'student').toLowerCase().trim();
    const isStudent = cleanRole === 'student';

    try {
        const userExists = await pool.query(
            "SELECT * FROM users WHERE UPPER(usn) = UPPER($1) AND COALESCE(institution_id, 'DR_AIT') ILIKE $2", 
            [usn.trim(), tenant]
        );
        if (userExists.rows.length > 0) return res.status(400).json({ success: false, message: "USN / Username already registered." });
        
        await pool.query(
            `INSERT INTO users (
                usn, email, password, role, name, child_usn, 
                subject_name, branch, institution_id, phone_number,
                device_fingerprint, biometric_enabled
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
                usn.trim().toUpperCase(), 
                email ? email.trim() : `${usn.trim()}@drait.edu.in`, 
                password, 
                cleanRole, 
                name || usn, 
                childUsn || null, 
                cleanRole === 'teacher' || cleanRole === 'hod' ? subjectName : null, 
                branch || 'AIML',
                tenant, 
                phoneNumber || '+919876543210',
                deviceFingerprint || null,
                isStudent ? true : false
            ]
        );
        return res.status(201).json({ success: true, message: "Account and device bound successfully!" });
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

// 4. SUBMIT ATTENDANCE
router.post("/submit-attendance", async (req, res) => {
    const { studentId, subjectName, sessionCode, distance, latitude, longitude, institutionId } = req.body;
    const tenant = institutionId || 'DR_AIT';
    try {
        const sessionResult = await pool.query("SELECT * FROM class_sessions WHERE session_code = $1 AND institution_id = $2", [sessionCode, tenant]);
        if (sessionResult.rows.length === 0) {
            await pool.query("INSERT INTO class_sessions (session_code, subject_name, institution_id, created_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT DO NOTHING", [sessionCode, subjectName || 'AI', tenant]);
        }

        const studentLookup = await pool.query("SELECT name FROM users WHERE UPPER(usn) = UPPER($1) AND institution_id = $2", [studentId, tenant]);
        const studentFullName = studentLookup.rows[0]?.name || 'Student';

        const duplicateCheck = await pool.query("SELECT * FROM users_attendance WHERE student_id = $1 AND session_code = $2 AND institution_id = $3", [studentId, sessionCode, tenant]);
        if (duplicateCheck.rows.length > 0) return res.status(400).json({ success: false, message: "Attendance duplicate flagged." });

        let isProxySuspected = false;
        if (latitude && longitude) {
            if (Math.abs(parseFloat(latitude) - 12.9634) > 0.003 || Math.abs(parseFloat(longitude) - 77.5058) > 0.003) isProxySuspected = true;
        }

        const parsedDistance = parseFloat(distance) || 0.22;
        const finalDistanceText = isProxySuspected ? `${parsedDistance}_PROXY` : `${parsedDistance}`;
        
        await pool.query(
            "INSERT INTO users_attendance (student_id, student_full_name, subject_name, session_code, distance, latitude, longitude, institution_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())", 
            [studentId, studentFullName, subjectName || 'AI', sessionCode, finalDistanceText, latitude || null, longitude || null, tenant]
        );

        return res.status(200).json({ success: true, message: "Attendance successfully recorded!", is_proxy: isProxySuspected });
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

        for (let student of allStudents.rows) {
            if (!presentUsns.includes(student.usn.toUpperCase())) {
                const studentAttendedResult = await pool.query("SELECT COUNT(*) as attended FROM users_attendance WHERE student_id = $1 AND subject_name = $2 AND institution_id = $3", [student.usn, targetSubject, tenant]);
                const totalAttended = parseInt(studentAttendedResult.rows[0].attended) || 0;
                const calculatedPercentage = Math.round((totalAttended / totalConducted) * 100);

                console.log(`📱 [ALERT BROADCAST] -> TO: ${student.name} | PHONE: ${student.phone_number || 'Linked'} | Absence warning for ${targetSubject} (${calculatedPercentage}%).`);
            }
        }
        return res.json({ success: true });
    } catch (err) { return res.status(500).json({ message: err.message }); }
});

// 6. STREAM REGISTRY DATA FEEDS (Teacher Live Feed Polling)
router.get("/attendance-records", async (req, res) => {
    const { sessionCode, institutionId } = req.query;
    const tenant = institutionId || 'DR_AIT';
    try {
        let queryStr = `
            SELECT a.id, a.student_id, a.session_code, a.distance, a.created_at, a.subject_name, 
                   COALESCE(a.student_full_name, u.name, 'Verified Student') AS student_full_name
            FROM users_attendance a
            LEFT JOIN users u ON UPPER(a.student_id) = UPPER(u.usn)
            WHERE a.institution_id = $1
        `;
        const params = [tenant];
        if (sessionCode) { queryStr += " AND a.session_code = $2 "; params.push(sessionCode); }
        queryStr += " ORDER BY a.created_at DESC";
        const result = await pool.query(queryStr, params);
        
        const processedRows = result.rows.map(row => {
            const distVal = row.distance ? row.distance.toString() : "0.14";
            const hasProxyFlag = distVal.includes('_PROXY');
            return { 
                ...row, 
                distance: hasProxyFlag ? distVal.split('_')[0] + "m" : distVal + "m", 
                is_proxy: hasProxyFlag 
            };
        });
        return res.json(processedRows);
    } catch (err) { return res.status(500).json({ error: err.message }); }
});

// 7. FIXED ALL-SEMESTER DATA-DRIVEN METRICS PERF ENDPOINT
router.get("/student-subject-metrics", async (req, res) => {
    const { studentId, institutionId } = req.query;
    const tenant = institutionId || 'DR_AIT';
    try {
        const totalConducted = await pool.query("SELECT subject_name, COUNT(*) as conducted FROM class_sessions WHERE institution_id = $1 GROUP BY subject_name", [tenant]);
        const totalAttended = await pool.query("SELECT subject_name, COUNT(*) as attended FROM users_attendance WHERE student_id = $1 AND institution_id = $2 GROUP BY subject_name", [studentId, tenant]);
        const logsHistory = await pool.query("SELECT subject_name, created_at FROM users_attendance WHERE student_id = $1 AND institution_id = $2 ORDER BY created_at DESC", [studentId, tenant]);
        
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
router.get("/student-marks-roster", async (req, res, next) => {
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
    } catch (err) { next(err); }
});

module.exports = router;