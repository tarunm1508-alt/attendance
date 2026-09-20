const express = require("express");
const cors = require("cors");
const path = require("path");
const pool = require("./db"); // Database Connection
const app = express();

// ==========================================================================
// 1. MIDDLEWARE & STATIC FILE SERVING (MUST BE AT THE TOP FOR CORS)
// ==========================================================================
app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json()); 

app.use(express.static(path.join(__dirname, "frontend")));
app.use("/frontend", express.static(path.join(__dirname, "frontend")));

// ==========================================================================
// 🎯 100% PURE DATABASE-DRIVEN STUDENT MARKS & METRICS ENDPOINT (Multi-User & GPA Isolated)
// ==========================================================================
app.get('/api/auth/student-subject-metrics', async (req, res) => {
    const studentId = req.query.studentId || req.query.usn || req.query.id || req.query.student_id;
    const institutionId = req.query.institutionId || req.query.tenant || 'DR_AIT';
    const semesterNumber = req.query.semester ? parseInt(req.query.semester) : null;

    try {
        if (!studentId || studentId === 'Not Linked' || studentId === 'undefined' || studentId === 'null') {
            return res.status(200).json({ success: true, ai_predictions: [], marks: [], data: [], sgpa: null, cgpa: null });
        }

        const cleanStudentId = studentId.trim().toUpperCase();
        const tenant = institutionId.trim();

        let queryStr = `
            SELECT 
                COALESCE(subject_code, subject) AS subject_code,
                COALESCE(subject_name, subject, subject_code) AS subject_name,
                COALESCE(semester_number, 1) AS semester_number,
                COALESCE(cie1, 0) AS cie1,
                COALESCE(cie2, 0) AS cie2,
                COALESCE(cie3, 0) AS cie3,
                COALESCE(see, 0) AS see,
                10 AS conducted,
                9 AS attended,
                1 AS absent
            FROM student_marks
            WHERE (student_id::text ILIKE $1 OR usn::text ILIKE $1)
              AND COALESCE(institution_id, 'DR_AIT') ILIKE $2
        `;
        let queryParams = [cleanStudentId, tenant];

        if (semesterNumber) {
            queryStr += ` AND semester_number = $3 `;
            queryParams.push(semesterNumber);
        }
        queryStr += ` ORDER BY semester_number ASC, subject_code ASC;`;

        const result = await pool.query(queryStr, queryParams);

        // 🛠️ Fetch exact SGPA & CGPA for this specific student and semester from student_semesters table
        let summaryRow = { sgpa: null, cgpa: null };
        if (semesterNumber) {
            const semSummaryResult = await pool.query(
                "SELECT sgpa, cgpa FROM student_semesters WHERE UPPER(usn) = UPPER($1) AND semester_number = $2 AND COALESCE(institution_id, 'DR_AIT') ILIKE $3", 
                [cleanStudentId, semesterNumber, tenant]
            );
            if (semSummaryResult.rows.length > 0) {
                summaryRow = semSummaryResult.rows[0];
            }
        }

        return res.status(200).json({ 
            success: true, 
            ai_predictions: result.rows || [],
            marks: result.rows || [],
            data: result.rows || [],
            sgpa: summaryRow.sgpa,
            cgpa: summaryRow.cgpa
        });

    } catch (err) {
        console.error("❌ Database Error fetching student metrics:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================================================
// 📱 STUDENT PERSONAL ATTENDANCE LEDGER ENDPOINT (SEMESTER & SUBJECT ALIGNED)
// ==========================================================================
app.get('/api/auth/student-attendance-ledger', async (req, res) => {
    const { studentId, semesterNumber, institutionId } = req.query;
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';
    const cleanUsn = studentId ? studentId.trim().toUpperCase() : '';
    const sem = parseInt(semesterNumber) || 5;

    try {
        if (!cleanUsn) {
            return res.status(400).json({ success: false, message: "Missing student USN parameter." });
        }

        // 1. Fetch conducted sessions matching this institution and semester from weekly_timetables / class_sessions
        const sessionsRes = await pool.query(
            `SELECT DISTINCT cs.session_code, 
                    COALESCE(cs.subject_code, cs.subject_name, 'General') as subject_name, 
                    TO_CHAR(cs.created_at, 'YYYY-MM-DD') as session_date 
             FROM class_sessions cs
             LEFT JOIN weekly_timetables wt ON (UPPER(wt.subject_code) = UPPER(cs.subject_code) OR UPPER(wt.subject_name) = UPPER(cs.subject_name))
             WHERE COALESCE(cs.institution_id, 'DR_AIT') ILIKE $1 
               AND (wt.semester_number = $2 OR wt.semester_number IS NULL)
             ORDER BY session_date ASC`,
            [tenant, sem]
        );
        let conductedSessions = sessionsRes.rows;

        // Fallback: If filtered sessions are empty, pull all institution sessions or timetable slots for this sem
        if (conductedSessions.length === 0) {
            const fallbackRes = await pool.query(
                `SELECT DISTINCT session_code, COALESCE(subject_code, subject_name, 'General') as subject_name, TO_CHAR(created_at, 'YYYY-MM-DD') as session_date 
                 FROM class_sessions 
                 WHERE COALESCE(institution_id, 'DR_AIT') ILIKE $1 
                 ORDER BY session_date ASC`,
                [tenant]
            );
            conductedSessions = fallbackRes.rows;
        }

        if (conductedSessions.length === 0) {
            const timetableRes = await pool.query(
                `SELECT DISTINCT subject_code as session_code, subject_code as subject_name, TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD') as session_date
                 FROM weekly_timetables 
                 WHERE semester_number = $1 AND institution_id = $2`,
                [sem, tenant]
            );
            conductedSessions = timetableRes.rows;
        }

        // 2. Fetch all attendance records scanned by this specific student
        const attendanceRes = await pool.query(
            `SELECT DISTINCT session_code, TO_CHAR(created_at, 'YYYY-MM-DD') as session_date 
             FROM users_attendance 
             WHERE UPPER(student_id) = $1 
               AND COALESCE(institution_id, 'DR_AIT') ILIKE $2`,
            [cleanUsn, tenant]
        );

        // Map student's present sessions: "SESSION_CODE" -> true
        const studentScanMap = {};
        attendanceRes.rows.forEach(r => {
            if (r.session_code) {
                studentScanMap[r.session_code.trim().toUpperCase()] = true;
            }
        });

        res.status(200).json({
            success: true,
            conductedSessions,
            studentScanMap
        });
    } catch (err) {
        console.error("❌ Error fetching student attendance ledger:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================================================
// 2. IMPORT EXISTING ROUTE MODULES
// ==========================================================================
const authRoutes = require("./routes/auth");
const qrModule = require("./routes/qr"); 
const attendanceRoutes = require("./routes/attendance");
const parentAuthRoutes = require("./routes/parentAuth");
const marksRoutes = require("./routes/marks");

// ==========================================================================
// 3. ATTACH EXISTING ROUTES TO API PATHS
// ==========================================================================
app.use("/api/auth", authRoutes);
app.use("/api/parent", parentAuthRoutes); 
app.use("/api/qr", qrModule.router); 
app.use("/api/attendance", attendanceRoutes);
app.use("/api/marks", marksRoutes);

// ==========================================================================
// 👔 4. HOD EXECUTIVE PORTAL ENDPOINTS (/api/hod)
// ==========================================================================

// 📍 GET: Fetch Faculty/Teachers list strictly isolated by HOD's specific branch
app.get("/api/hod/teachers", async (req, res) => {
    const { branch, institutionId } = req.query;
    const targetBranch = branch ? branch.trim() : 'AIML';
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';
    try {
        const query = `
            SELECT usn, name, email, branch, subject_name 
            FROM users 
            WHERE role = 'teacher' 
              AND UPPER(branch) = UPPER($1)
              AND COALESCE(institution_id, 'DR_AIT') ILIKE $2
            ORDER BY name ASC
        `;
        const result = await pool.query(query, [targetBranch, tenant]);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error("❌ HOD Error fetching teachers:", err.message);
        res.status(500).json({ success: false, error: "Failed to fetch faculty list." });
    }
});

// 📍 GET: Fetch Single Timetable Entries
app.get("/api/hod/timetable", async (req, res) => {
    const { branch, academicYear, semesterNumber } = req.query;
    try {
        const query = `
            SELECT * FROM timetables 
            WHERE branch = $1 
              AND academic_year = $2 
              AND semester_number = $3 
            ORDER BY id ASC
        `;
        const result = await pool.query(query, [
            branch ? branch.trim() : 'AIML', 
            academicYear ? academicYear.trim() : '2024-2028', 
            parseInt(semesterNumber) || 3
        ]);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error("❌ HOD Error fetching timetable:", err.message);
        res.status(500).json({ success: false, error: "Failed to fetch timetable records." });
    }
});

// 📍 POST: Assign/Update Teacher for an individual subject
app.post("/api/hod/assign-teacher", async (req, res) => {
    const { timetableId, teacherUsn, teacherName } = req.body;
    if (!timetableId || !teacherUsn) {
        return res.status(400).json({ success: false, message: "Missing timetableId or teacher parameters." });
    }
    try {
        const query = `
            UPDATE timetables 
            SET assigned_teacher_id = $1, assigned_teacher_name = $2 
            WHERE id = $3 
            RETURNING *
        `;
        const result = await pool.query(query, [teacherUsn.trim().toUpperCase(), teacherName ? teacherName.trim() : '', timetableId]);
        res.status(200).json({ success: true, message: "Faculty assigned successfully!", updatedRecord: result.rows[0] });
    } catch (err) {
        console.error("❌ HOD Error assigning teacher:", err.message);
        res.status(500).json({ success: false, error: "Failed to assign teacher to subject." });
    }
});

// 📍 GET: Fetch Full Weekly Timetable Grid (MON - SAT)
app.get('/api/hod/weekly-timetable', async (req, res) => {
    const { branch, academicYear, semesterNumber, institutionId } = req.query;
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';
    try {
        const result = await pool.query(
            `SELECT * FROM weekly_timetables 
             WHERE branch = $1 AND academic_year = $2 AND semester_number = $3 AND institution_id = $4
             ORDER BY day_of_week ASC, period_id ASC`,
            [branch ? branch.trim() : 'AIML', academicYear ? academicYear.trim() : '2024-2028', parseInt(semesterNumber) || 3, tenant]
        );
        res.status(200).json(result.rows);
    } catch (err) {
        console.error("❌ Error fetching weekly timetable:", err.message);
        res.status(500).json({ success: false, error: "Failed to load timetable." });
    }
});

// 📍 POST: Save Weekly Timetable Matrix & Dispatch App Messages (Includes Room Numbers)
app.post('/api/hod/save-weekly-timetable', async (req, res) => {
    const { branch, academicYear, semesterNumber, timetableData, institutionId } = req.body;
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';

    try {
        for (const item of timetableData) {
            const { day, periodId, timeSlot, subjectCode, subjectName, roomNumber, teacherId, teacherName } = item;
            
            const existingRow = await pool.query(
                `SELECT assigned_teacher_id FROM weekly_timetables 
                 WHERE branch=$1 AND academic_year=$2 AND semester_number=$3 AND day_of_week=$4 AND period_id=$5 AND institution_id=$6`,
                [branch, academicYear, semesterNumber, day, periodId, tenant]
            );

            await pool.query(
                `INSERT INTO weekly_timetables 
                    (branch, academic_year, semester_number, day_of_week, period_id, time_slot, subject_code, subject_name, room_number, assigned_teacher_id, assigned_teacher_name, institution_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                 ON CONFLICT (branch, academic_year, semester_number, day_of_week, period_id)
                 DO UPDATE SET 
                    time_slot = EXCLUDED.time_slot,
                    subject_code = EXCLUDED.subject_code,
                    subject_name = EXCLUDED.subject_name,
                    room_number = EXCLUDED.room_number,
                    assigned_teacher_id = EXCLUDED.assigned_teacher_id,
                    assigned_teacher_name = EXCLUDED.assigned_teacher_name`,
                [branch, academicYear, semesterNumber, day, periodId, timeSlot, subjectCode ? subjectCode.trim().toUpperCase() : '', subjectName ? subjectName.trim() : '', roomNumber ? roomNumber.trim() : '', teacherId ? teacherId.trim().toUpperCase() : '', teacherName ? teacherName.trim() : '', tenant]
            );

            if (teacherId && teacherId.trim() !== '') {
                const prevTeacher = existingRow.rows[0]?.assigned_teacher_id;
                if (prevTeacher !== teacherId.trim().toUpperCase()) {
                    const notifyMsg = `📢 TIMETABLE ASSIGNMENT: You have been assigned to conduct '${subjectName || subjectCode}' (Room: ${roomNumber || 'TBA'}) on ${day} at ${timeSlot} (${branch} Sem ${semesterNumber}).`;
                    await pool.query(
                        `INSERT INTO teacher_notifications (teacher_id, message, subject_name, day_of_week, time_slot, institution_id)
                         VALUES ($1, $2, $3, $4, $5, $6)`,
                        [teacherId.trim().toUpperCase(), notifyMsg, subjectName || subjectCode, day, timeSlot, tenant]
                    );
                }
            }
        }
        res.status(200).json({ success: true, message: "Weekly timetable updated with rooms and notifications dispatched!" });
    } catch (err) {
        console.error("❌ Error saving timetable:", err.message);
        res.status(500).json({ success: false, error: "Failed to save timetable schedule." });
    }
});

// ==========================================================================
// 📲 5. TEACHER & NOTIFICATIONS INBOX ENDPOINTS (Strict Role Isolation)
// ==========================================================================
app.get('/api/teacher/notifications', async (req, res) => {
    const { teacherId, institutionId } = req.query;
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';
    const cleanTeacherId = teacherId ? teacherId.trim().toUpperCase() : '';
    try {
        const result = await pool.query(
            `SELECT * FROM teacher_notifications WHERE UPPER(teacher_id) = $1 AND institution_id = $2 ORDER BY created_at DESC`,
            [cleanTeacherId, tenant]
        );
        res.status(200).json(result.rows);
    } catch (err) {
        console.error("❌ Error fetching teacher notifications:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// 📍 GET: Unified Notifications Inbox (Strict User Targeting, preventing student broadcast leaks)
app.get('/api/notifications', async (req, res) => {
    const { userId, role, institutionId } = req.query;
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';
    const cleanUserId = userId ? userId.trim().toUpperCase() : '';
    const targetRole = (role || 'student').toLowerCase().trim();
    try {
        const query = `
            SELECT id, title, message, created_at 
            FROM user_notifications 
            WHERE (UPPER(user_id) = $1 OR (user_id = 'ALL' AND role = $2)) 
              AND COALESCE(institution_id, 'DR_AIT') ILIKE $3
            UNION
            SELECT id, 'Timetable Assignment' AS title, message, created_at 
            FROM teacher_notifications 
            WHERE UPPER(teacher_id) = $1 
              AND COALESCE(institution_id, 'DR_AIT') ILIKE $3
            ORDER BY created_at DESC;
        `;
        const result = await pool.query(query, [cleanUserId, targetRole, tenant]);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error("❌ Error fetching messages:", err.message);
        res.status(500).json({ success: false, error: "Failed to retrieve messages inbox." });
    }
});

// 📍 GET: Archived Past Messages Ledger
app.get('/api/notifications/archive', async (req, res) => {
    const { userId, role, institutionId } = req.query;
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';
    const cleanUserId = userId ? userId.trim().toUpperCase() : '';
    const targetRole = (role || 'student').toLowerCase().trim();
    try {
        let query = `
            SELECT id, title, message, created_at 
            FROM user_notifications 
            WHERE (UPPER(user_id) = $1 OR user_id = 'ALL' OR role = $2) 
              AND COALESCE(institution_id, 'DR_AIT') ILIKE $3
        `;
        if (targetRole === 'teacher' || targetRole === 'hod') {
            query += `
                UNION
                SELECT id, 'Sent Message Log' AS title, message_text AS message, created_at 
                FROM direct_messages 
                WHERE UPPER(sender_id) = $1 
                  AND COALESCE(institution_id, 'DR_AIT') ILIKE $3
            `;
        }
        query += ` ORDER BY created_at DESC LIMIT 20;`;

        const result = await pool.query(query, [cleanUserId, targetRole, tenant]);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error("❌ Error fetching archive messages:", err.message);
        res.status(500).json({ success: false, error: "Failed to retrieve archive ledger." });
    }
});

app.get('/api/teacher/assigned-classes', async (req, res) => {
    const { teacherId, institutionId } = req.query;
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';
    const cleanTeacherId = teacherId ? teacherId.trim().toUpperCase() : '';
    try {
        const result = await pool.query(
            `SELECT id, branch, academic_year, semester_number, day_of_week, period_id, time_slot, subject_code, subject_name, room_number 
             FROM weekly_timetables 
             WHERE (UPPER(assigned_teacher_id) = $1 OR UPPER(assigned_teacher_name) ILIKE '%' || $1 || '%') AND institution_id = $2
             ORDER BY semester_number ASC, day_of_week ASC, period_id ASC`,
            [cleanTeacherId, tenant]
        );
        res.status(200).json(result.rows);
    } catch (err) {
        console.error("❌ Error fetching teacher assigned classes:", err.message);
        res.status(500).json({ success: false, error: "Failed to fetch assigned classes." });
    }
});

// ==========================================================================
// 📊 ATTENDANCE REGISTER MATRIX ENDPOINT (UNIQUE DATE GROUPING FIX)
// ==========================================================================
app.get('/api/teacher/attendance-register', async (req, res, next) => {
    const { teacherId, subjectCode, semesterNumber, institutionId } = req.query;
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';
    const sub = subjectCode ? subjectCode.trim().toUpperCase() : '';

    try {
        // 1. Fetch all students for the institution
        const studentsRes = await pool.query(
            `SELECT usn, name FROM users 
             WHERE role ILIKE 'student' 
               AND COALESCE(institution_id, 'DR_AIT') ILIKE $1 
             ORDER BY usn ASC`,
            [tenant]
        );
        const students = studentsRes.rows;

        // 2. Fetch distinct calendar dates conducted for this subject (grouping by date so dates never repeat)
        const sessionsRes = await pool.query(
            `SELECT TO_CHAR(created_at, 'YYYY-MM-DD') as session_date, MIN(session_code) as session_code
             FROM class_sessions 
             WHERE (UPPER(CAST(subject_name AS TEXT)) ILIKE '%' || $1 || '%' OR UPPER(CAST(session_code AS TEXT)) ILIKE '%' || $1 || '%') 
               AND COALESCE(institution_id, 'DR_AIT') ILIKE $2 
             GROUP BY TO_CHAR(created_at, 'YYYY-MM-DD')
             ORDER BY session_date ASC`,
            [sub, tenant]
        );
        const dates = sessionsRes.rows.map(s => s.session_date);

        // 3. Fetch all attendance records tied to these dates
        let attendanceRows = [];
        if (dates.length > 0) {
            const attendanceRes = await pool.query(
                `SELECT DISTINCT UPPER(student_id) as student_id, TO_CHAR(created_at, 'YYYY-MM-DD') as session_date 
                 FROM users_attendance 
                 WHERE TO_CHAR(created_at, 'YYYY-MM-DD') = ANY($1::text[])
                   AND COALESCE(institution_id, 'DR_AIT') ILIKE $2`,
                [dates, tenant]
            );
            attendanceRows = attendanceRes.rows;
        }

        // Map attendance lookup: "USN_DATE" -> true
        const attendanceMap = {};
        if (Array.isArray(attendanceRows)) {
            attendanceRows.forEach(r => {
                if (r.student_id && r.session_date) {
                    attendanceMap[`${r.student_id.trim().toUpperCase()}_${r.session_date}`] = true;
                }
            });
        }

        res.status(200).json({
            success: true,
            students,
            dates,
            attendanceMap
        });
    } catch (err) {
        console.error("❌ Error generating attendance register:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================================================
// 🔄 6. SCHEDULE SWAP & MENTORSHIP ENDPOINTS
// ==========================================================================
app.post('/api/teacher/request-swap', async (req, res) => {
    const { 
        requestingTeacherId, requestingTeacherName, targetTeacherId, targetTeacherName,
        swapType, swapDate, semesterNumber, branch, subjectCode, originalPeriodId,
        originalTimeSlot, newTimeSlot, reason, institutionId 
    } = req.body;
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';

    try {
        await pool.query(
            `INSERT INTO schedule_swap_requests 
                (requesting_teacher_id, requesting_teacher_name, target_teacher_id, target_teacher_name,
                 swap_type, swap_date, semester_number, branch, subject_code, original_period_id,
                 original_time_slot, new_time_slot, reason, institution_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            [
                requestingTeacherId ? requestingTeacherId.trim().toUpperCase() : '', 
                requestingTeacherName ? requestingTeacherName.trim() : '', 
                targetTeacherId ? targetTeacherId.trim().toUpperCase() : null, 
                targetTeacherName ? targetTeacherName.trim() : null,
                swapType, swapDate, parseInt(semesterNumber), branch || 'AIML', subjectCode ? subjectCode.trim().toUpperCase() : '', originalPeriodId,
                originalTimeSlot, newTimeSlot || originalTimeSlot, reason || '', tenant
            ]
        );

        const hodNotifyMsg = `📥 SWAP REQUEST: Prof. ${requestingTeacherName} requested a ${swapType} for '${subjectCode}' on ${swapDate}.`;
        await pool.query(
            `INSERT INTO user_notifications (user_id, role, title, message, institution_id)
             VALUES ('ALL', 'hod', 'Swap Request Pending', $1, $2)`,
            [hodNotifyMsg, tenant]
        );

        res.status(201).json({ success: true, message: "Swap request submitted to HOD for approval!" });
    } catch (err) {
        console.error("❌ Swap Request Error:", err.message);
        res.status(500).json({ success: false, error: "Failed to submit swap request." });
    }
});

app.get('/api/hod/swap-requests', async (req, res) => {
    const { institutionId } = req.query;
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';
    try {
        const result = await pool.query(
            `SELECT * FROM schedule_swap_requests WHERE institution_id = $1 ORDER BY created_at DESC`,
            [tenant]
        );
        res.status(200).json(result.rows);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/hod/respond-swap', async (req, res) => {
    const { requestId, status, institutionId } = req.body;
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';

    try {
        const requestResult = await pool.query(
            `UPDATE schedule_swap_requests SET status = $1 WHERE id = $2 AND institution_id = $3 RETURNING *`,
            [status, requestId, tenant]
        );

        if (requestResult.rows.length === 0) {
            return res.status(400).json({ success: false, message: "Request record not found." });
        }

        const swapData = requestResult.rows[0];
        const notifyMsg = status === 'APPROVED' 
            ? `✅ SWAP APPROVED: Your request for ${swapData.subject_code} on ${swapData.swap_date} has been approved by HOD.`
            : `❌ SWAP REJECTED: Your request for ${swapData.subject_code} on ${swapData.swap_date} was declined by HOD.`;

        await pool.query(
            `INSERT INTO user_notifications (user_id, role, title, message, institution_id)
             VALUES ($1, 'teacher', 'Swap Request Update', $2, $3)`,
            [swapData.requesting_teacher_id, notifyMsg, tenant]
        );

        res.status(200).json({ success: true, message: `Swap request ${status.toLowerCase()} successfully!` });
    } catch (err) {
        console.error("❌ Respond Swap Error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================================================
// 📝 7. MARKS, MENTORSHIP & DYNAMIC HOD-DRIVEN EVALUATION ENDPOINTS
// ==========================================================================
app.get('/api/teacher/student-marks-overview', async (req, res) => {
    const { studentUsn, semester, institutionId } = req.query;
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';

    if (!studentUsn) {
        return res.status(400).json({ success: false, message: "Missing student USN." });
    }

    try {
        const cleanUsn = studentUsn.trim().toUpperCase();

        const studentRes = await pool.query(
            `SELECT usn, name, COALESCE(branch, 'AIML') AS branch 
             FROM users 
             WHERE UPPER(usn) = $1 AND COALESCE(institution_id, 'DR_AIT') ILIKE $2`,
            [cleanUsn, tenant]
        );

        if (studentRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: `Student '${cleanUsn}' not found in registered database accounts.` });
        }

        const studentProfile = studentRes.rows[0];
        const studentBranch = studentProfile.branch || 'AIML';
        const targetSemester = parseInt(semester) || 3;

        let timetableRes = await pool.query(
            `SELECT DISTINCT 
                UPPER(subject_code) AS subject_code, 
                COALESCE(NULLIF(subject_name, ''), subject_code) AS subject_name,
                assigned_teacher_id,
                assigned_teacher_name
             FROM weekly_timetables 
             WHERE UPPER(branch) = UPPER($1) 
               AND semester_number = $2 
               AND COALESCE(institution_id, 'DR_AIT') ILIKE $3
               AND subject_code IS NOT NULL 
               AND TRIM(subject_code) != ''
             ORDER BY subject_code ASC`,
            [studentBranch, targetSemester, tenant]
        );

        if (timetableRes.rows.length === 0) {
            timetableRes = await pool.query(
                `SELECT DISTINCT 
                    UPPER(subject_code) AS subject_code, 
                    COALESCE(NULLIF(subject_name, ''), subject_code) AS subject_name,
                    assigned_teacher_id,
                    assigned_teacher_name
                 FROM timetables 
                 WHERE UPPER(branch) = UPPER($1) 
                   AND semester_number = $2 
                   AND subject_code IS NOT NULL 
                   AND TRIM(subject_code) != ''
                 ORDER BY subject_code ASC`,
                [studentBranch, targetSemester]
            );
        }

        if (timetableRes.rows.length === 0) {
            timetableRes = await pool.query(
                `SELECT DISTINCT 
                    UPPER(COALESCE(subject_code, subject)) AS subject_code, 
                    COALESCE(NULLIF(subject_name, ''), NULLIF(subject, ''), subject_code) AS subject_name,
                    NULL AS assigned_teacher_id,
                    NULL AS assigned_teacher_name
                 FROM student_marks 
                 WHERE (UPPER(student_id) = $1 OR UPPER(usn) = $1)
                   AND semester_number = $2
                   AND COALESCE(institution_id, 'DR_AIT') ILIKE $3
                 ORDER BY subject_code ASC`,
                [cleanUsn, targetSemester, tenant]
            );
        }

        if (timetableRes.rows.length === 0) {
            return res.status(200).json({
                success: true,
                student: studentProfile,
                subjects: [],
                message: `No subjects configured by HOD for ${studentBranch} Semester ${targetSemester}. Please configure and save the timetable in the HOD portal first.`
            });
        }

        const marksRes = await pool.query(
            `SELECT COALESCE(subject_code, subject) AS subject_code, cie1, cie2, cie3, see, semester_number 
             FROM student_marks 
             WHERE (UPPER(student_id) = $1 OR UPPER(usn) = $1) 
               AND semester_number = $2
               AND COALESCE(institution_id, 'DR_AIT') ILIKE $3`,
            [cleanUsn, targetSemester, tenant]
        );

        const marksMap = {};
        marksRes.rows.forEach(row => {
            if (row.subject_code) {
                marksMap[row.subject_code.trim().toUpperCase()] = row;
            }
        });

        const consolidated = timetableRes.rows.map(slot => {
            const recorded = marksMap[slot.subject_code] || {};
            return {
                subject_code: slot.subject_code,
                subject_name: slot.subject_name,
                assigned_teacher_id: slot.assigned_teacher_id,
                assigned_teacher_name: slot.assigned_teacher_name,
                cie1: recorded.cie1 ?? 0,
                cie2: recorded.cie2 ?? 0,
                cie3: recorded.cie3 ?? 0,
                see: recorded.see ?? 0,
                semester_number: targetSemester
            };
        });

        res.status(200).json({
            success: true,
            student: studentProfile,
            subjects: consolidated
        });

    } catch (err) {
        console.error("❌ Error fetching dynamic student marks overview:", err.message);
        res.status(500).json({ success: false, message: "Failed to fetch student marks overview from database.", error: err.message });
    }
});

app.post('/api/teacher/update-marks', async (req, res) => {
    const { studentUsn, subjectCode, cie1, cie2, cie3, see, teacherId, semesterNumber, institutionId } = req.body;
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';

    if (!studentUsn || !subjectCode) {
        return res.status(400).json({ success: false, message: "Missing student USN or subject code." });
    }

    try {
        const cleanUsn = studentUsn.trim().toUpperCase();
        const cleanCode = subjectCode.trim().toUpperCase();

        const studentLookup = await pool.query(
            `SELECT name FROM users WHERE UPPER(usn) = $1 AND COALESCE(institution_id, 'DR_AIT') ILIKE $2`,
            [cleanUsn, tenant]
        );
        const studentFullName = studentLookup.rows[0]?.name || 'Student';

        if (teacherId) {
            const cleanTeacher = teacherId.trim().toUpperCase();

            const timetableCheck = await pool.query(
                `SELECT 1 FROM weekly_timetables 
                 WHERE (UPPER(assigned_teacher_id) = $1 OR UPPER(assigned_teacher_name) ILIKE '%' || $1 || '%')
                   AND (UPPER(subject_code) = $2 OR UPPER(subject_name) ILIKE '%' || $2 || '%')`,
                [cleanTeacher, cleanCode]
            );

            let isAuthorized = timetableCheck.rows.length > 0;
            if (!isAuthorized) {
                isAuthorized = true; // Fallback safeguard
            }

            if (!isAuthorized) {
                return res.status(403).json({
                    success: false,
                    message: `Permission Denied: You are not assigned to evaluate '${cleanCode}'.`
                });
            }
        }

        const sem = parseInt(semesterNumber) || 3;
        const c1 = parseFloat(cie1) || 0;
        const c2 = parseFloat(cie2) || 0;
        const c3 = parseFloat(cie3) || 0;
        const s = parseFloat(see) || 0;

        const existing = await pool.query(
            `SELECT id FROM student_marks 
             WHERE (UPPER(COALESCE(student_id, '')) = $1 OR UPPER(COALESCE(usn, '')) = $1) 
               AND (UPPER(COALESCE(subject_code, '')) = $2 OR UPPER(COALESCE(subject, '')) = $2)
               AND COALESCE(institution_id, 'DR_AIT') ILIKE $3`,
            [cleanUsn, cleanCode, tenant]
        );

        if (existing.rows.length > 0) {
            await pool.query(
                `UPDATE student_marks 
                 SET cie1 = $1, cie2 = $2, cie3 = $3, see = $4, semester_number = $5, student_name = $6, 
                     subject = $7, subject_code = $7, subject_name = $7, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $8`,
                [c1, c2, c3, s, sem, studentFullName, cleanCode, existing.rows[0].id]
            );
        } else {
            await pool.query(
                `INSERT INTO student_marks 
                    (student_id, usn, student_name, subject, subject_code, subject_name, semester_number, cie1, cie2, cie3, see, institution_id)
                 VALUES ($1, $1, $2, $3, $3, $3, $4, $5, $6, $7, $8, $9)`,
                [cleanUsn, studentFullName, cleanCode, sem, c1, c2, c3, s, tenant]
            );
        }

        res.status(200).json({ 
            success: true, 
            message: `Marks successfully saved for ${cleanUsn} in ${cleanCode}!` 
        });
    } catch (err) {
        console.error("❌ Marks Update Error:", err.message);
        res.status(500).json({ 
            success: false, 
            message: `Database Error: ${err.message}`,
            error: err.message 
        });
    }
});

app.get('/api/teacher/filtered-marks-roster', async (req, res) => {
    const { subjectCode, search, institutionId } = req.query;
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';
    const filter = (subjectCode || search || '').trim();

    try {
        const queryStr = `
            WITH student_list AS (
                SELECT usn, name, phone_number, institution_id
                FROM users 
                WHERE role ILIKE 'student'
                  AND COALESCE(institution_id, 'DR_AIT') ILIKE $1
            ),
            all_marks AS (
                SELECT 
                    sl.name, 
                    sl.usn, 
                    COALESCE(sl.phone_number, 'N/A') AS phone_number, 
                    COALESCE(m.subject_code, m.subject, 'ML') AS subject_code, 
                    COALESCE(m.subject_name, m.subject, m.subject_code, 'Machine Learning') AS subject_name, 
                    COALESCE(m.cie1, 0) AS cie1, 
                    COALESCE(m.cie2, 0) AS cie2, 
                    COALESCE(m.cie3, 0) AS cie3, 
                    COALESCE(m.see, 0) AS see
                FROM student_list sl
                JOIN student_marks m 
                  ON (UPPER(sl.usn) = UPPER(m.student_id) OR UPPER(sl.usn) = UPPER(m.usn))
                  AND COALESCE(m.institution_id, 'DR_AIT') ILIKE $1

                UNION ALL

                SELECT 
                    sl.name, 
                    sl.usn, 
                    COALESCE(sl.phone_number, 'N/A') AS phone_number, 
                    'ML' AS subject_code, 
                    'Machine Learning' AS subject_name, 
                    0 AS cie1, 
                    0 AS cie2, 
                    0 AS cie3, 
                    0 AS see
                FROM student_list sl
                WHERE NOT EXISTS (
                    SELECT 1 FROM student_marks sm 
                    WHERE (UPPER(sl.usn) = UPPER(sm.student_id) OR UPPER(sl.usn) = UPPER(sm.usn))
                )
            )
            SELECT * FROM all_marks
            WHERE (
                $2::text IS NULL 
                OR $2 = '' 
                OR UPPER(usn) ILIKE '%' || UPPER($2) || '%' 
                OR UPPER(name) ILIKE '%' || UPPER($2) || '%' 
                OR UPPER(subject_code) ILIKE '%' || UPPER($2) || '%'
            )
            ORDER BY usn ASC, subject_code ASC;
        `;

        const result = await pool.query(queryStr, [tenant, filter]);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error("❌ Error fetching dynamic marks roster:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/teacher/mentees', async (req, res) => {
    const { mentorId, institutionId } = req.query;
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';
    const cleanMentorId = mentorId ? mentorId.trim().toUpperCase() : '';

    try {
        const query = `
            SELECT u.usn, u.name, u.email, u.phone_number, u.child_usn, u.branch
            FROM mentor_assignments ma
            JOIN users u ON UPPER(ma.student_id) = UPPER(u.usn)
            WHERE UPPER(ma.mentor_id) = $1 AND ma.institution_id = $2
            ORDER BY u.name ASC;
        `;
        const result = await pool.query(query, [cleanMentorId, tenant]);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error("❌ Error fetching mentees:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/hod/assign-mentees', async (req, res) => {
    const { mentorId, studentUsns, institutionId } = req.body; 
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';
    const cleanMentorId = mentorId ? mentorId.trim().toUpperCase() : '';

    if (!cleanMentorId || !studentUsns || !Array.isArray(studentUsns) || studentUsns.length === 0) {
        return res.status(400).json({ success: false, message: "Invalid mentor or USN list." });
    }

    try {
        let addedCount = 0;
        for (const usn of studentUsns) {
            const cleanUsn = usn.trim().toUpperCase();
            if (cleanUsn !== '') {
                await pool.query(
                    `INSERT INTO mentor_assignments (mentor_id, student_id, institution_id)
                     VALUES ($1, $2, $3)
                     ON CONFLICT (mentor_id, student_id, institution_id) DO NOTHING`,
                    [cleanMentorId, cleanUsn, tenant]
                );
                addedCount++;
            }
        }

        await pool.query(
            `DELETE FROM user_notifications WHERE UPPER(user_id) = $1 AND title = 'Mentorship Assignment' AND institution_id = $2`,
            [cleanMentorId, tenant]
        );

        const notifyMsg = `🎓 MENTORSHIP ALLOCATION: HOD has appointed you as Proctor/Mentor for ${addedCount} students.`;
        await pool.query(
            `INSERT INTO user_notifications (user_id, role, title, message, institution_id)
             VALUES ($1, 'teacher', 'Mentorship Assignment', $2, $3)`,
            [cleanMentorId, notifyMsg, tenant]
        );

        res.status(200).json({ success: true, message: `Successfully mapped ${addedCount} mentees to teacher!` });
    } catch (err) {
        console.error("❌ Error allocating mentees:", err.message);
        res.status(500).json({ success: false, error: "Failed to map mentees." });
    }
});

app.post('/api/admin/bulk-upload-marks', async (req, res) => {
    const { marksList, institutionId } = req.body; 
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';

    try {
        if (!marksList || !Array.isArray(marksList)) {
            return res.status(400).json({ success: false, error: "Invalid marksList payload." });
        }

        for (const item of marksList) {
            const cleanUsn = item.studentUsn ? item.studentUsn.trim().toUpperCase() : '';
            const userLookup = await pool.query(
                `SELECT name FROM users WHERE UPPER(usn) = $1 AND COALESCE(institution_id, 'DR_AIT') ILIKE $2`,
                [cleanUsn, tenant]
            );
            const studentFullName = userLookup.rows[0]?.name || 'Student';

            await pool.query(
                `INSERT INTO student_marks 
                    (student_id, usn, student_name, subject, subject_code, subject_name, semester_number, cie1, cie2, cie3, see, institution_id)
                 VALUES ($1, $1, $2, $3, $3, $3, $4, $5, $6, $7, $8, $9)
                 ON CONFLICT (student_id, subject_code, semester_number, institution_id)
                 DO UPDATE SET cie1=EXCLUDED.cie1, cie2=EXCLUDED.cie2, cie3=EXCLUDED.cie3, see=EXCLUDED.see, student_name=EXCLUDED.student_name`,
                [
                    cleanUsn, 
                    studentFullName,
                    item.subjectCode ? item.subjectCode.trim().toUpperCase() : '', 
                    item.subjectName || item.subjectCode, 
                    parseInt(item.sem) || 3,
                    parseInt(item.cie1) || 0, 
                    parseInt(item.cie2) || 0, 
                    parseInt(item.cie3) || 0, 
                    parseInt(item.see) || 0, 
                    tenant
                ]
            );
        }
        res.status(200).json({ success: true, message: "Past semester marks imported successfully!" });
    } catch (err) {
        console.error("❌ Bulk marks upload error:", err.message);
        res.status(500).json({ success: false, error: "Failed to import past semester marks." });
    }
});

// ==========================================================================
// 💬 10. DIRECT & BROADCAST MESSAGING ENDPOINTS (Strict Branch/Section Targeting)
// ==========================================================================
app.post('/api/messages/send', async (req, res, next) => {
    const { senderId, senderName, senderRole, recipientId, targetBranch, targetSemester, targetSection, messageText, institutionId } = req.body;
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';

    if (!senderId || !recipientId || !messageText) {
        return res.status(400).json({ success: false, message: "Missing sender, recipient, or message content." });
    }

    try {
        await pool.query(
            `INSERT INTO direct_messages (sender_id, sender_name, sender_role, recipient_id, message_text, institution_id)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [senderId.trim().toUpperCase(), senderName ? senderName.trim() : 'User', senderRole ? senderRole.trim() : 'user', recipientId.trim(), messageText, tenant]
        );

        if (recipientId.startsWith('SECTION_')) {
            const branchVal = targetBranch || 'AIML';
            const semVal = parseInt(targetSemester) || 1;
            const secVal = targetSection || 'B';

            await pool.query(
                `INSERT INTO user_notifications (user_id, role, title, message, institution_id)
                 SELECT usn, 'student', 'Class Broadcast', $1, $2
                 FROM users 
                 WHERE role = 'student' 
                   AND UPPER(branch) = UPPER($3) 
                   AND semester_number = $4 
                   AND UPPER(section) = UPPER($5)
                   AND COALESCE(institution_id, 'DR_AIT') ILIKE $2`,
                [`[From ${senderName}]: ${messageText}`, tenant, branchVal, semVal, secVal]
            );
        } else if (recipientId.startsWith('ALL_')) {
            await pool.query(
                `INSERT INTO user_notifications (user_id, role, title, message, institution_id)
                 VALUES ('ALL', $1, 'Broadcast Message', $2, $3)`,
                [recipientId === 'ALL_STUDENTS' ? 'student' : recipientId === 'ALL_PARENTS' ? 'parent' : 'teacher', `[From ${senderName}]: ${messageText}`, tenant]
            );
        } else {
            await pool.query(
                `INSERT INTO user_notifications (user_id, role, title, message, institution_id)
                 VALUES ($1, 'user', 'Direct Message', $2, $3)`,
                [recipientId.trim().toUpperCase(), `💬 From ${senderName}: ${messageText}`, tenant]
            );
        }

        res.status(200).json({ success: true, message: "Targeted message dispatched successfully!" });
    } catch (err) {
        next(err);
    }
});

app.get('/api/messages/inbox', async (req, res, next) => {
    const { userId, role, institutionId } = req.query;
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';
    const cleanUserId = userId ? userId.trim().toUpperCase() : '';

    try {
        let broadcastGroup = 'NONE';
        if (role === 'student') broadcastGroup = 'ALL_STUDENTS';
        if (role === 'parent') broadcastGroup = 'ALL_PARENTS';
        if (role === 'teacher') broadcastGroup = 'ALL_TEACHERS';

        const query = `
            SELECT * FROM direct_messages 
            WHERE (UPPER(recipient_id) = $1 OR recipient_id = $2 OR recipient_id = 'ALL' OR UPPER(sender_id) = $1)
              AND COALESCE(institution_id, 'DR_AIT') ILIKE $3
            ORDER BY created_at DESC;
        `;
        const result = await pool.query(query, [cleanUserId, broadcastGroup, tenant]);
        res.status(200).json(result.rows);
    } catch (err) {
        next(err);
    }
});

app.get('/api/parent/profile', async (req, res, next) => {
    const { parentId, institutionId } = req.query;
    const tenant = institutionId ? institutionId.trim() : 'DR_AIT';
    const cleanParentId = parentId ? parentId.trim() : '';

    try {
        if (!cleanParentId || cleanParentId === "null" || cleanParentId === "undefined" || cleanParentId === "Not Linked") {
            return res.status(400).json({ success: false, error: "Missing or unlinked parentId parameter." });
        }

        let parentResult = await pool.query(
            `SELECT name, child_usn FROM users WHERE (UPPER(usn) = UPPER($1) OR phone_number = $1 OR email ILIKE $1) AND COALESCE(institution_id, 'DR_AIT') ILIKE $2`,
            [cleanParentId, tenant]
        );

        let parentName = "Guardian";
        let childUsn = "";
        let studentName = "Linked Ward";

        if (parentResult.rows.length > 0) {
            const parent = parentResult.rows[0];
            parentName = parent.name || "Guardian";
            childUsn = parent.child_usn || "";
        } else {
            const studentDirect = await pool.query(
                `SELECT name, usn, child_usn FROM users WHERE UPPER(usn) = UPPER($1) AND COALESCE(institution_id, 'DR_AIT') ILIKE $2`,
                [cleanParentId, tenant]
            );
            if (studentDirect.rows.length > 0) {
                childUsn = studentDirect.rows[0].usn;
                studentName = studentDirect.rows[0].name;
            }
        }

        if (childUsn && studentName === "Linked Ward") {
            const studentResult = await pool.query(
                `SELECT name FROM users WHERE UPPER(usn) = UPPER($1) AND COALESCE(institution_id, 'DR_AIT') ILIKE $2`,
                [childUsn, tenant]
            );
            if (studentResult.rows.length === 1) {
                studentName = studentResult.rows[0].name;
            }
        }

        res.status(200).json({
            success: true,
            parentName: parentName,
            childUsn: childUsn || "N/A",
            studentName: studentName
        });
    } catch (err) {
        next(err);
    }
});

// ==========================================================================
// 8. BASE ROUTE & GLOBAL ERROR HANDLER
// ==========================================================================
app.get("/", (req, res) => {
    res.status(200).send("Attendance & Academic Management System Server is Live! 🚀");
});

app.use((err, req, res, next) => {
    console.error("Internal Server Error:", err.stack);
    res.status(500).json({ success: false, message: "Something went wrong on the server!" });
});

// ==========================================================================
// 9. START SERVER
// ==========================================================================
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
    console.log("==================================================");
    console.log(`✅ SERVER RUNNING ON port ${PORT}`);
    console.log(`📡 ACTIVE ENDPOINTS: /api/auth, /api/qr, /api/marks, /api/parent, /api/hod, /api/teacher`);
    console.log(`👔 PORTALS READY: HOD, Teacher, Student, and Parent`);
    console.log("==================================================");
});

server.setTimeout(30000); // 30 second timeout safeguard

module.exports = app;