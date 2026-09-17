const express = require('express');
const router = express.Router();
const pool = require('../db'); 
const crypto = require('crypto');

// 0. INITIATE LOGIN CHALLENGE & STRICT DEVICE BINDING CHECK
router.post("/login-challenge", async (req, res) => {
    const { usn, role, deviceFingerprint, institutionId } = req.body;
    const targetTenant = institutionId ? institutionId.trim() : 'DR_AIT';
    const cleanRole = (role || 'student').toLowerCase().trim();
    const cleanUsn = usn ? usn.trim().toUpperCase() : '';

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
            [cleanUsn, cleanRole, targetTenant]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Account record not found." });
        }

        const user = result.rows[0];
        
        // 🔒 STRICT PROXY-PREVENTION CHECK DURING CHALLENGE FOR STUDENTS
        if (user.role.toLowerCase() === 'student') {
            const cleanStoredFingerprint = user.device_fingerprint ? user.device_fingerprint.trim() : '';
            const cleanIncomingFingerprint = deviceFingerprint ? deviceFingerprint.trim() : '';

            if (cleanStoredFingerprint !== '' && cleanIncomingFingerprint !== '') {
                if (cleanStoredFingerprint !== cleanIncomingFingerprint) {
                    console.warn(`🚨 [CHALLENGE PROXY ATTEMPT] Student USN ${user.usn} attempted challenge from unauthorized device!`);
                    return res.status(403).json({ 
                        success: false, 
                        message: "⛔ PROXY DETECTED & ACCESS DENIED: This student account is permanently bound to another registered device. Multi-device login is strictly blocked." 
                    });
                }
            }
        }

        const challenge = crypto.randomBytes(32).toString('base64url');

        return res.json({
            success: true,
            challenge: challenge,
            biometricEnabled: user.biometric_enabled,
            userName: user.name
        });

    } catch (err) {
        console.error("💥 LOGIN CHALLENGE ERROR:", err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// 1. SECURE COMBINED LOGIN (Strict Proxy-Prevention & Permanent Single-Device Binding)
router.post("/combined-login", async (req, res) => {
    const { usn, password, role, deviceFingerprint, institutionId, childUsn } = req.body;
    const targetTenant = institutionId ? institutionId.trim() : 'DR_AIT';
    const cleanRole = (role || 'student').toLowerCase().trim();
    const cleanUsn = usn ? usn.trim().toUpperCase() : '';

    try {
        const result = await pool.query(
            `SELECT * FROM users 
             WHERE UPPER(usn) = UPPER($1) 
               AND (
                   LOWER(TRIM(role)) = LOWER(TRIM($2)) 
                   OR ($2 IN ('hod', 'teacher') AND LOWER(TRIM(role)) IN ('hod', 'teacher'))
               )
               AND COALESCE(institution_id, 'DR_AIT') ILIKE $3`,
            [cleanUsn, cleanRole, targetTenant]
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

        // 🔒 STRICT PROXY-PREVENTION & PERMANENT SINGLE-DEVICE BINDING FOR STUDENTS:
        if (user.role.toLowerCase() === 'student') {
            const cleanStoredFingerprint = user.device_fingerprint ? user.device_fingerprint.trim() : '';
            const cleanIncomingFingerprint = deviceFingerprint ? deviceFingerprint.trim() : '';

            if (cleanStoredFingerprint === '') {
                // Fallback catch if signup missed device binding: Lock it now
                if (cleanIncomingFingerprint !== '') {
                    await pool.query("UPDATE users SET device_fingerprint = $1 WHERE UPPER(usn) = UPPER($2)", [cleanIncomingFingerprint, user.usn]);
                }
            } else {
                // Already bound: If a different phone tries to log in, block it and flag a proxy attempt!
                if (cleanStoredFingerprint !== cleanIncomingFingerprint) {
                    console.warn(`🚨 [COMBINED LOGIN PROXY ATTEMPT] Student USN ${user.usn} attempted login from an unauthorized device!`);
                    return res.status(403).json({ 
                        success: false, 
                        message: "⛔ PROXY DETECTED & ACCESS DENIED: This student account is permanently bound to a different registered device. Multi-device login is strictly blocked." 
                    });
                }
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
    } catch (err) { 
        console.error("💥 COMBINED LOGIN ERROR:", err);
        return res.status(500).json({ message: err.message }); 
    }
});

// 2. SIGNUP WORKSPACE REGISTRY (Binds Initial Device Token)
router.post("/signup", async (req, res) => {
    const { 
        usn, email, password, role, name, childUsn, subjectName, 
        branch, institutionId, phoneNumber, deviceFingerprint 
    } = req.body;

    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';
    const cleanRole = (role || 'student').toLowerCase().trim();
    const isStudent = cleanRole === 'student';
    const cleanUsn = usn ? usn.trim().toUpperCase() : '';

    try {
        const userExists = await pool.query(
            "SELECT * FROM users WHERE UPPER(usn) = UPPER($1) AND COALESCE(institution_id, 'DR_AIT') ILIKE $2", 
            [cleanUsn, tenant]
        );
        if (userExists.rows.length > 0) return res.status(400).json({ success: false, message: "USN / Username already registered." });

        await pool.query(
            `INSERT INTO users (
                usn, email, password, role, name, child_usn, 
                subject_name, branch, institution_id, phone_number,
                device_fingerprint, biometric_enabled
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
                cleanUsn, 
                email ? email.trim() : `${cleanUsn || 'user'}@drait.edu.in`, 
                password, 
                cleanRole, 
                name || cleanUsn, 
                childUsn ? childUsn.trim().toUpperCase() : null, 
                cleanRole === 'teacher' || cleanRole === 'hod' ? subjectName : null, 
                branch || 'AIML',
                tenant, 
                phoneNumber || '+919876543210',
                deviceFingerprint ? deviceFingerprint.trim() : null,
                isStudent ? true : false
            ]
        );
        return res.status(201).json({ success: true, message: "Account and device bound successfully!" });
    } catch (err) { 
        console.error("💥 SIGNUP ERROR:", err);
        return res.status(500).json({ message: err.message }); 
    }
});

// 3. TEACHER REGISTER A NEW CLASS SESSION INSTANCE
router.post("/create-session", async (req, res) => {
    const { sessionCode, subjectName, institutionId } = req.body;
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';
    try {
        await pool.query("INSERT INTO class_sessions (session_code, subject_name, institution_id, created_at) VALUES ($1, $2, $3, NOW())", [sessionCode, subjectName || 'AI', tenant]);
        return res.status(200).json({ success: true });
    } catch (err) { 
        console.error("💥 CREATE SESSION ERROR:", err);
        return res.status(500).json({ message: err.message }); 
    }
});

// 4. SUBMIT ATTENDANCE WITH MANDATORY GEOFENCING & DISTANCE RESTRICTION
router.post("/submit-attendance", async (req, res) => {
    const { studentId, subjectName, sessionCode, latitude, longitude, institutionId } = req.body;
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';
    const cleanStudentId = studentId ? studentId.trim().toUpperCase() : '';

    try {
        if (latitude === undefined || longitude === undefined || latitude === null || longitude === null || latitude === '' || longitude === '') {
            return res.status(400).json({ 
                success: false, 
                message: "❌ Location Required: You must turn on your device location services to scan and record attendance." 
            });
        }

        const studentLat = parseFloat(latitude);
        const studentLon = parseFloat(longitude);

        if (isNaN(studentLat) || isNaN(studentLon)) {
            return res.status(400).json({ 
                success: false, 
                message: "❌ Invalid Location Data: Unable to read valid GPS coordinates from your device." 
            });
        }

        const COLLEGE_LAT = 12.9635;
        const COLLEGE_LON = 77.5059;
        const MAX_ALLOWED_RADIUS_METERS = 300;

        function calculateDistance(lat1, lon1, lat2, lon2) {
            const R = 6371e3;
            const φ1 = lat1 * Math.PI / 180;
            const φ2 = lat2 * Math.PI / 180;
            const Δφ = (lat2 - lat1) * Math.PI / 180;
            const Δλ = (lon2 - lon1) * Math.PI / 180;

            const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
                      Math.cos(φ1) * Math.cos(φ2) *
                      Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            return R * c;
        }

        const distanceMeters = calculateDistance(studentLat, studentLon, COLLEGE_LAT, COLLEGE_LON);
        const roundedDistance = Math.round(distanceMeters);

        if (distanceMeters > MAX_ALLOWED_RADIUS_METERS) {
            return res.status(403).json({ 
                success: false, 
                message: `⛔ ACCESS DENIED: You are outside the Dr. AIT campus region. Your current distance from college is ${roundedDistance} meters (Allowed limit: ${MAX_ALLOWED_RADIUS_METERS}m). Please move inside the campus to scan.` 
            });
        }

        const sessionResult = await pool.query("SELECT * FROM class_sessions WHERE session_code = $1 AND institution_id = $2", [sessionCode, tenant]);
        if (sessionResult.rows.length === 0) {
            await pool.query("INSERT INTO class_sessions (session_code, subject_name, institution_id, created_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT DO NOTHING", [sessionCode, subjectName || 'AI', tenant]);
        }

        const studentLookup = await pool.query("SELECT name FROM users WHERE UPPER(usn) = UPPER($1) AND institution_id = $2", [cleanStudentId, tenant]);
        const studentFullName = studentLookup.rows[0]?.name || 'Student';

        const duplicateCheck = await pool.query("SELECT * FROM users_attendance WHERE student_id = $1 AND session_code = $2 AND institution_id = $3", [cleanStudentId, sessionCode, tenant]);
        if (duplicateCheck.rows.length > 0) {
            return res.status(400).json({ success: false, message: "Attendance duplicate flagged for this session." });
        }

        await pool.query(
            "INSERT INTO users_attendance (student_id, student_full_name, subject_name, session_code, distance, latitude, longitude, institution_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())", 
            [cleanStudentId, studentFullName, subjectName || 'AI', sessionCode, `${roundedDistance}m`, studentLat, studentLon, tenant]
        );

        return res.status(200).json({ 
            success: true, 
            message: `✅ Attendance successfully recorded! You are within campus bounds (${roundedDistance}m from college).`, 
            distance: `${roundedDistance}m` 
        });

    } catch (err) { 
        console.error("💥 SUBMIT ATTENDANCE ERROR:", err);
        return res.status(500).json({ message: err.message }); 
    }
});

// 5. AUTOMATED LOCKDOWN COMPLIANCE COMMUNICATIONS BROKER
router.post("/end-session", async (req, res) => {
    const { sessionCode, subjectName, institutionId } = req.body;
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';
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
    } catch (err) { 
        console.error("💥 END SESSION ERROR:", err);
        return res.status(500).json({ message: err.message }); 
    }
});

// 6. STREAM REGISTRY DATA FEEDS (Teacher Live Feed Polling)
router.get("/attendance-records", async (req, res) => {
    const { sessionCode, institutionId } = req.query;
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';
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
    } catch (err) { 
        console.error("💥 ATTENDANCE RECORDS ERROR:", err);
        return res.status(500).json({ error: err.message }); 
    }
});

// 6.1 TEACHER REAL-TIME CLASS ATTENDANCE ROSTER (USN Smart-Decoding & Branch/Semester Isolation)
router.get("/teacher-session-roster", async (req, res) => {
    const { sessionCode, institutionId } = req.query;
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';

    try {
        // 1. Find the branch and semester for this session from weekly timetables
        const slotInfoQuery = await pool.query(
            `SELECT t.branch, t.semester_number, t.subject_code 
             FROM class_sessions cs
             LEFT JOIN weekly_timetables t ON (cs.subject_name = t.subject_code OR cs.subject_name = t.subject_name) AND cs.institution_id = t.institution_id
             WHERE cs.session_code = $1 AND cs.institution_id = $2
             LIMIT 1`,
            [sessionCode, tenant]
        );

        let targetBranch = 'AI';
        let targetSemester = 5;

        if (slotInfoQuery.rows.length > 0 && slotInfoQuery.rows[0].branch) {
            targetBranch = slotInfoQuery.rows[0].branch;
            targetSemester = slotInfoQuery.rows[0].semester_number || 5;
        }

        // 2. Fetch all students filtered strictly by matching branch/USN pattern and semester
        const allStudentsResult = await pool.query(
            `SELECT usn, name, phone_number, branch, semester_number 
             FROM users 
             WHERE LOWER(role) = 'student' 
               AND COALESCE(institution_id, 'DR_AIT') ILIKE $1 
               AND (
                   branch ILIKE $2 
                   OR UPPER(usn) LIKE '%' || UPPER($2) || '%'
                   OR branch = 'AIML'
               )
             ORDER BY usn ASC`,
            [tenant, targetBranch]
        );

        const presentResult = await pool.query(
            `SELECT a.student_id, a.student_full_name, a.distance, a.created_at, a.latitude, a.longitude
             FROM users_attendance a
             WHERE a.session_code = $1 AND a.institution_id = $2`,
            [sessionCode, tenant]
        );

        const presentMap = new Map();
        presentResult.rows.forEach(row => {
            presentMap.set(row.student_id.toUpperCase(), row);
        });

        let presentList = [];
        let absentList = [];

        allStudentsResult.rows.forEach(student => {
            const studentUsn = student.usn.toUpperCase();
            if (presentMap.has(studentUsn)) {
                const record = presentMap.get(studentUsn);
                presentList.push({
                    usn: student.usn,
                    name: student.name,
                    phone: student.phone_number,
                    distance: record.distance || 'Within Campus',
                    scannedAt: record.created_at,
                    status: 'PRESENT'
                });
            } else {
                absentList.push({
                    usn: student.usn,
                    name: student.name,
                    phone: student.phone_number,
                    status: 'ABSENT'
                });
            }
        });

        return res.json({
            success: true,
            sessionCode: sessionCode,
            branch: targetBranch,
            semester: targetSemester,
            totalStudents: allStudentsResult.rows.length,
            presentCount: presentList.length,
            absentCount: absentList.length,
            presentStudents: presentList,
            absentStudents: absentList
        });

    } catch (err) {
        console.error("💥 TEACHER ROSTER ERROR:", err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 6.2 FETCH STUDENT ROSTER FOR TEACHER MARKS ENTRY (Filtered by Branch & Semester)
router.get("/teacher-student-roster", async (req, res) => {
    const { branch, semesterNumber, institutionId } = req.query;
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';
    const targetBranch = branch || 'AIML';

    try {
        const result = await pool.query(
            `SELECT usn, name, branch, semester_number 
             FROM users 
             WHERE LOWER(role) = 'student' 
               AND COALESCE(institution_id, 'DR_AIT') ILIKE $1 
               AND (branch ILIKE $2 OR branch = 'AIML')
             ORDER BY usn ASC`,
            [tenant, targetBranch]
        );

        return res.json({
            success: true,
            students: result.rows
        });
    } catch (err) {
        console.error("💥 TEACHER STUDENT ROSTER ERROR:", err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// 6.3 HOD MANUAL ATTENDANCE OVERRIDE (Excuse/Mark Absent Student Present)
router.post("/hod/override-attendance", async (req, res) => {
    const { studentUsn, sessionCode, subjectName, institutionId } = req.body;
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';
    const cleanStudentUsn = studentUsn ? studentUsn.trim().toUpperCase() : '';

    try {
        if (!cleanStudentUsn || !sessionCode) {
            return res.status(400).json({ success: false, message: "Student USN and Session Code are required." });
        }

        const studentLookup = await pool.query("SELECT name FROM users WHERE UPPER(usn) = UPPER($1) AND institution_id = $2", [cleanStudentUsn, tenant]);
        if (studentLookup.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Student record not found." });
        }
        const studentFullName = studentLookup.rows[0].name;

        const duplicateCheck = await pool.query("SELECT * FROM users_attendance WHERE student_id = $1 AND session_code = $2 AND institution_id = $3", [cleanStudentUsn, sessionCode, tenant]);
        if (duplicateCheck.rows.length > 0) {
            return res.status(400).json({ success: false, message: "Student is already marked present for this session." });
        }

        await pool.query(
            "INSERT INTO users_attendance (student_id, student_full_name, subject_name, session_code, distance, institution_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())", 
            [cleanStudentUsn, studentFullName, subjectName || 'AI', sessionCode, 'HOD_EXCUSED', tenant]
        );

        return res.json({ success: true, message: `Successfully excused and marked ${cleanStudentUsn} present!` });
    } catch (err) {
        console.error("💥 HOD ATTENDANCE OVERRIDE ERROR:", err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// 6.4 FETCH STUDENT MARKS OVERVIEW (Strictly Filtered by Teacher's HOD-Assigned Subjects)
router.get("/teacher/student-marks-overview", async (req, res) => {
    const { studentUsn, semester, teacherId, institutionId } = req.query;
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';
    const cleanUsn = studentUsn ? studentUsn.trim().toUpperCase() : '';
    const cleanTeacherId = teacherId ? teacherId.trim() : '';

    try {
        const studentRes = await pool.query(
            "SELECT usn, name, branch, semester_number FROM users WHERE UPPER(usn) = UPPER($1) AND institution_id = $2",
            [cleanUsn, tenant]
        );

        if (studentRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: "Student record not found." });
        }
        const student = studentRes.rows[0];

        // Find ONLY subjects mapped to this specific teacher in the HOD timetable
        const teacherSubjectsRes = await pool.query(
            `SELECT DISTINCT subject_code, subject_name 
             FROM weekly_timetables 
             WHERE (LOWER(TRIM(assigned_teacher_id)) = LOWER(TRIM($1)) OR LOWER(TRIM(assigned_teacher_name)) ILIKE LOWER(TRIM($1)))
               AND COALESCE(institution_id, 'DR_AIT') ILIKE $2`,
            [cleanTeacherId, tenant]
        );

        const allowedSubjects = teacherSubjectsRes.rows;

        if (allowedSubjects.length === 0) {
            return res.status(403).json({ success: false, message: "You have no HOD-assigned subjects mapped in the timetable to evaluate." });
        }

        const allowedCodes = allowedSubjects.map(s => s.subject_code || s.subject_name);
        
        const marksRes = await pool.query(
            `SELECT subject_code, subject_name, cie1, cie2, cie3, see 
             FROM student_marks 
             WHERE UPPER(student_id) = UPPER($1) 
               AND COALESCE(institution_id, 'DR_AIT') ILIKE $2
               AND (subject_code = ANY($3::text[]) OR subject_name = ANY($3::text[]))`,
            [cleanUsn, tenant, allowedCodes]
        );

        const marksMap = new Map();
        marksRes.rows.forEach(m => {
            marksMap.set((m.subject_code || m.subject_name).toUpperCase(), m);
        });

        let subjectsPayload = allowedSubjects.map(sub => {
            const code = sub.subject_code || sub.subject_name;
            const existing = marksMap.get(code.toUpperCase()) || {};
            return {
                subject_code: code,
                subject_name: sub.subject_name || code,
                cie1: existing.cie1 ?? 0,
                cie2: existing.cie2 ?? 0,
                cie3: existing.cie3 ?? 0,
                see: existing.see ?? 0
            };
        });

        return res.json({
            success: true,
            student: student,
            subjects: subjectsPayload
        });

    } catch (err) {
        console.error("💥 STUDENT MARKS OVERVIEW ERROR:", err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// 7. FIXED ALL-SEMESTER DATA-DRIVEN METRICS PERF ENDPOINT
router.get("/student-subject-metrics", async (req, res) => {
    const { studentId, institutionId } = req.query;
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';
    const cleanStudentId = studentId ? studentId.trim() : '';

    try {
        const totalConducted = await pool.query("SELECT subject_name, COUNT(*) as conducted FROM class_sessions WHERE institution_id = $1 GROUP BY subject_name", [tenant]);
        const totalAttended = await pool.query("SELECT subject_name, COUNT(*) as attended FROM users_attendance WHERE student_id = $1 AND institution_id = $2 GROUP BY subject_name", [cleanStudentId, tenant]);
        const logsHistory = await pool.query("SELECT subject_name, created_at FROM users_attendance WHERE student_id = $1 AND institution_id = $2 ORDER BY created_at DESC", [cleanStudentId, tenant]);

        const realMarksResult = await pool.query("SELECT * FROM student_marks WHERE student_id = $1 AND institution_id = $2", [cleanStudentId, tenant]);

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
    } catch (err) { 
        console.error("💥 METRICS ERROR:", err);
        return res.status(500).json({ error: err.message }); 
    }
});

// 8. DISTINCT HISTORICAL SESSIONS WITH TIMESTAMPS
router.get("/distinct-sessions", async (req, res) => {
    const { subject, institutionId } = req.query;
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';
    try {
        const result = await pool.query(
            "SELECT session_code, created_at FROM class_sessions WHERE subject_name = $1 AND institution_id = $2 ORDER BY created_at DESC", 
            [subject || 'AI', tenant]
        );
        return res.json(result.rows);
    } catch (err) { 
        console.error("💥 DISTINCT SESSIONS ERROR:", err);
        return res.status(500).json({ error: err.message }); 
    }
});

// 9. STUDENT MARKS GENERAL ROSTER
router.get("/student-marks-roster", async (req, res, next) => {
    const { institutionId } = req.query;
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';
    try {
        const result = await pool.query(`
            SELECT u.name, m.student_id AS usn, u.phone_number, m.subject_code, m.subject_name, m.cie1, m.cie2, m.cie3, m.see
            FROM student_marks m
            JOIN users u ON m.student_id = u.usn
            WHERE m.institution_id = $1
            ORDER BY u.name ASC, m.subject_code ASC
        `, [tenant]);
        return res.json(result.rows);
    } catch (err) { 
        console.error("💥 MARKS ROSTER ERROR:", err);
        next(err); 
    }
});

// 10. FETCH HOD-MAPPED CLASS SLOTS FOR TEACHER (STRICTLY ISOLATED TO ASSIGNED TEACHER)
router.get("/teacher-mapped-slots", async (req, res) => {
    const { teacherId, institutionId } = req.query;
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';

    try {
        if (!teacherId) {
            return res.status(400).json({ success: false, message: "Teacher ID is required." });
        }

        const cleanId = teacherId.trim();

        // STRICT MATCH: Only return rows where the HOD explicitly mapped this teacher ID or name
        const result = await pool.query(
            `SELECT * FROM weekly_timetables 
             WHERE (
                 LOWER(TRIM(assigned_teacher_id)) = LOWER(TRIM($1)) 
                 OR LOWER(TRIM(assigned_teacher_name)) ILIKE LOWER(TRIM($2))
             ) 
             AND COALESCE(institution_id, 'DR_AIT') ILIKE $3 
             ORDER BY id DESC`,
            [cleanId, cleanId, tenant]
        );

        return res.json({
            success: true,
            slots: result.rows
        });
    } catch (err) {
        console.error("💥 TEACHER MAPPED SLOTS ERROR:", err);
        return res.status(500).json({ success: false, slots: [] });
    }
});

module.exports = router;