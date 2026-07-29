const express = require("express");
const cors = require("cors");
const path = require("path");
const pool = require("./db"); // Database Connection
const app = express();

// ==========================================================================
// 1. MIDDLEWARE & STATIC FILE SERVING
// ==========================================================================
// Robust CORS configuration supporting both web browsers and mobile WebView (Capacitor)
app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json()); 

// Serve static HTML/CSS/JS frontend files seamlessly
app.use(express.static(path.join(__dirname, "frontend")));
app.use("/frontend", express.static(path.join(__dirname, "frontend")));


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

// 📍 GET: Fetch Faculty/Teachers list for HOD assignment dropdown
app.get("/api/hod/teachers", async (req, res) => {
    const { branch, institutionId } = req.query;
    try {
        const query = `
            SELECT usn, name, email, branch 
            FROM users 
            WHERE role = 'teacher' 
              AND (branch = $1 OR branch IS NULL OR $1 = 'ALL')
            ORDER BY name ASC
        `;
        const result = await pool.query(query, [branch || 'AIML']);
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
            branch || 'AIML', 
            academicYear || '2024-2028', 
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
        const result = await pool.query(query, [teacherUsn, teacherName, timetableId]);
        
        console.log(`✅ [HOD ALLOCATION]: Assigned ${teacherName} (${teacherUsn}) to Timetable Entry ID ${timetableId}`);
        res.status(200).json({ success: true, message: "Faculty assigned successfully!", updatedRecord: result.rows[0] });
    } catch (err) {
        console.error("❌ HOD Error assigning teacher:", err.message);
        res.status(500).json({ success: false, error: "Failed to assign teacher to subject." });
    }
});

// 📍 GET: Fetch Full Dr. AIT 7-Period Weekly Timetable Grid (MON - SAT)
app.get('/api/hod/weekly-timetable', async (req, res) => {
    const { branch, academicYear, semesterNumber, institutionId } = req.query;
    const tenant = institutionId || 'DR_AIT';
    try {
        const result = await pool.query(
            `SELECT * FROM weekly_timetables 
             WHERE branch = $1 AND academic_year = $2 AND semester_number = $3 AND institution_id = $4
             ORDER BY day_of_week ASC, period_id ASC`,
            [branch || 'AIML', academicYear || '2024-2028', parseInt(semesterNumber) || 3, tenant]
        );
        res.status(200).json(result.rows);
    } catch (err) {
        console.error("❌ Error fetching weekly timetable:", err.message);
        res.status(500).json({ success: false, error: "Failed to load timetable." });
    }
});

// 📍 POST: Save Weekly Timetable Matrix & Dispatch App Messages to Assigned Professors
app.post('/api/hod/save-weekly-timetable', async (req, res) => {
    const { branch, academicYear, semesterNumber, timetableData, institutionId } = req.body;
    const tenant = institutionId || 'DR_AIT';

    try {
        for (const item of timetableData) {
            const { day, periodId, timeSlot, subjectCode, subjectName, teacherId, teacherName } = item;

            // Check previous assignment to know if a new teacher was assigned
            const existingRow = await pool.query(
                `SELECT assigned_teacher_id FROM weekly_timetables 
                 WHERE branch=$1 AND academic_year=$2 AND semester_number=$3 AND day_of_week=$4 AND period_id=$5`,
                [branch, academicYear, semesterNumber, day, periodId]
            );

            // Upsert Timetable Slot
            await pool.query(
                `INSERT INTO weekly_timetables 
                    (branch, academic_year, semester_number, day_of_week, period_id, time_slot, subject_code, subject_name, assigned_teacher_id, assigned_teacher_name, institution_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                 ON CONFLICT (branch, academic_year, semester_number, day_of_week, period_id)
                 DO UPDATE SET 
                    time_slot = EXCLUDED.time_slot,
                    subject_code = EXCLUDED.subject_code,
                    subject_name = EXCLUDED.subject_name,
                    assigned_teacher_id = EXCLUDED.assigned_teacher_id,
                    assigned_teacher_name = EXCLUDED.assigned_teacher_name`,
                [branch, academicYear, semesterNumber, day, periodId, timeSlot, subjectCode || '', subjectName || '', teacherId || '', teacherName || '', tenant]
            );

            // 📩 DISPATCH APP MESSAGE TO PROFESSOR
            if (teacherId && teacherId !== '') {
                const prevTeacher = existingRow.rows[0]?.assigned_teacher_id;
                if (prevTeacher !== teacherId) {
                    const notifyMsg = `📢 TIMETABLE ASSIGNMENT: You have been assigned to conduct '${subjectName || subjectCode}' on ${day} at ${timeSlot} (${branch} Sem ${semesterNumber}).`;
                    await pool.query(
                        `INSERT INTO teacher_notifications (teacher_id, message, subject_name, day_of_week, time_slot, institution_id)
                         VALUES ($1, $2, $3, $4, $5, $6)`,
                        [teacherId, notifyMsg, subjectName || subjectCode, day, timeSlot, tenant]
                    );
                    console.log(`📱 [APP MESSAGE DISPATCHED]: To ${teacherName} (${teacherId}) -> ${notifyMsg}`);
                }
            }
        }

        res.status(200).json({ success: true, message: "Weekly timetable updated and notifications dispatched!" });
    } catch (err) {
        console.error("❌ Error saving timetable:", err.message);
        res.status(500).json({ success: false, error: "Failed to save timetable schedule." });
    }
});


// ==========================================================================
// 📲 5. TEACHER NOTIFICATIONS INBOX ENDPOINTS
// ==========================================================================
app.get('/api/teacher/notifications', async (req, res) => {
    const { teacherId, institutionId } = req.query;
    const tenant = institutionId || 'DR_AIT';
    try {
        const result = await pool.query(
            `SELECT * FROM teacher_notifications WHERE teacher_id = $1 AND institution_id = $2 ORDER BY created_at DESC`,
            [teacherId, tenant]
        );
        res.status(200).json(result.rows);
    } catch (err) {
        console.error("❌ Error fetching teacher notifications:", err.message);
        res.status(500).json({ error: err.message });
    }
});


// ==========================================================================
// 6. BASE / TEST ROUTE
// ==========================================================================
app.get("/", (req, res) => {
    res.status(200).send("Attendance & Academic Management System Server is Live! 🚀");
});


// ==========================================================================
// 7. GLOBAL ERROR HANDLER
// ==========================================================================
app.use((err, req, res, next) => {
    console.error("Internal Server Error:", err.stack);
    res.status(500).json({ success: false, message: "Something went wrong on the server!" });
});


// ==========================================================================
// 8. START SERVER (FIXED FOR RENDER DYNAMIC PORT)
// ==========================================================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log("==================================================");
    console.log(`✅ SERVER RUNNING ON port ${PORT}`);
    console.log(`📡 ACTIVE ENDPOINTS: /api/auth, /api/qr, /api/marks, /api/parent, /api/hod, /api/teacher`);
    console.log(`👔 PORTALS READY: HOD, Teacher, Student, and Parent`);
    console.log("==================================================");
});

// 📍 GET: Unified Messages Inbox for Any Role (Student, Teacher, Parent, HOD)
app.get('/api/notifications', async (req, res) => {
    const { userId, role, institutionId } = req.query;
    const tenant = institutionId || 'DR_AIT';
    
    try {
        const query = `
            SELECT id, message, 'Timetable Assignment' AS title, created_at 
            FROM teacher_notifications 
            WHERE teacher_id = $1 AND institution_id = $2
            
            UNION ALL
            
            SELECT id, message, title, created_at 
            FROM user_notifications 
            WHERE (user_id = $1 OR user_id = 'ALL' OR role = $3) AND institution_id = $2
            
            ORDER BY created_at DESC;
        `;
        const result = await pool.query(query, [userId || '', tenant, role || 'all']);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error("❌ Error fetching messages:", err.message);
        res.status(500).json({ success: false, error: "Failed to retrieve messages inbox." });
    }
});

// 📍 GET: Fetch All HOD-Assigned Class Slots for a Specific Teacher (Sem 1 to 8)
app.get('/api/teacher/assigned-classes', async (req, res) => {
    const { teacherId, institutionId } = req.query;
    const tenant = institutionId || 'DR_AIT';
    
    try {
        const result = await pool.query(
            `SELECT id, branch, academic_year, semester_number, day_of_week, period_id, time_slot, subject_code, subject_name 
             FROM weekly_timetables 
             WHERE (assigned_teacher_id = $1 OR assigned_teacher_id = $2) AND institution_id = $3
             ORDER BY semester_number ASC, day_of_week ASC, period_id ASC`,
            [teacherId, teacherId.toUpperCase(), tenant]
        );
        res.status(200).json(result.rows);
    } catch (err) {
        console.error("❌ Error fetching teacher assigned classes:", err.message);
        res.status(500).json({ success: false, error: "Failed to fetch assigned classes." });
    }
});

// 📍 1. TEACHER: Send Class Swap or Leave Cover Request to HOD
app.post('/api/teacher/request-swap', async (req, res) => {
    const { 
        requestingTeacherId, requestingTeacherName, targetTeacherId, targetTeacherName,
        swapType, swapDate, semesterNumber, branch, subjectCode, originalPeriodId,
        originalTimeSlot, newTimeSlot, reason, institutionId 
    } = req.body;
    
    const tenant = institutionId || 'DR_AIT';

    try {
        await pool.query(
            `INSERT INTO schedule_swap_requests 
                (requesting_teacher_id, requesting_teacher_name, target_teacher_id, target_teacher_name,
                 swap_type, swap_date, semester_number, branch, subject_code, original_period_id,
                 original_time_slot, new_time_slot, reason, institution_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            [
                requestingTeacherId, requestingTeacherName, targetTeacherId || null, targetTeacherName || null,
                swapType, swapDate, parseInt(semesterNumber), branch || 'AIML', subjectCode, originalPeriodId,
                originalTimeSlot, newTimeSlot || originalTimeSlot, reason || '', tenant
            ]
        );

        // Notify HOD Inbox
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

// 📍 2. HOD: Fetch Pending Swap Requests
app.get('/api/hod/swap-requests', async (req, res) => {
    const { institutionId } = req.query;
    const tenant = institutionId || 'DR_AIT';

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

// 📍 3. HOD: Approve or Reject Swap Request
app.post('/api/hod/respond-swap', async (req, res) => {
    const { requestId, status, institutionId } = req.body; // status: 'APPROVED' or 'REJECTED'
    const tenant = institutionId || 'DR_AIT';

    try {
        const requestResult = await pool.query(
            `UPDATE schedule_swap_requests SET status = $1 WHERE id = $2 AND institution_id = $3 RETURNING *`,
            [status, requestId, tenant]
        );

        if (requestResult.rows.length === 0) {
            return res.status(400).json({ success: false, message: "Request record not found." });
        }

        const swapData = requestResult.rows[0];

        // Send confirmation message to teacher
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

// 📍 1. GET Filtered Student Marks by Semester and/or Subject
app.get('/api/teacher/filtered-marks-roster', async (req, res) => {
    const { subjectCode, semesterNumber, institutionId } = req.query;
    const tenant = institutionId || 'DR_AIT';

    try {
        let queryStr = `
            SELECT u.name, m.student_id AS usn, u.phone_number, m.subject_code, m.subject_name, m.cie1, m.cie2, m.cie3, m.see
            FROM student_marks m
            JOIN users u ON m.student_id = u.usn
            WHERE m.institution_id = $1
        `;
        const params = [tenant];

        if (subjectCode && subjectCode !== '') {
            params.push(subjectCode);
            queryStr += ` AND UPPER(m.subject_code) = UPPER($${params.length})`;
        }

        queryStr += ` ORDER BY u.name ASC, m.subject_code ASC`;

        const result = await pool.query(queryStr, params);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error("❌ Error fetching filtered marks:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// 📍 2. GET Assigned Mentees List for a Mentor/Teacher
app.get('/api/teacher/mentees', async (req, res) => {
    const { mentorId, institutionId } = req.query;
    const tenant = institutionId || 'DR_AIT';

    try {
        const query = `
            SELECT u.usn, u.name, u.email, u.phone_number, u.child_usn, u.branch
            FROM mentor_assignments ma
            JOIN users u ON ma.student_id = u.usn
            WHERE ma.mentor_id = $1 AND ma.institution_id = $2
            ORDER BY u.name ASC;
        `;
        const result = await pool.query(query, [mentorId, tenant]);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error("❌ Error fetching mentees:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// 📍 POST: HOD Assign Batch of Mentees/Students to a Mentor (Teacher)
app.post('/api/hod/assign-mentees', async (req, res) => {
    const { mentorId, studentUsns, institutionId } = req.body; 
    const tenant = institutionId || 'DR_AIT';

    if (!mentorId || !studentUsns || !Array.isArray(studentUsns) || studentUsns.length === 0) {
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
                    [mentorId, cleanUsn, tenant]
                );
                addedCount++;
            }
        }

        // Send confirmation notification directly to the Professor's inbox
        const notifyMsg = `🎓 MENTORSHIP ALLOCATION: HOD has appointed you as Proctor/Mentor for ${addedCount} students (${studentUsns[0]} to ${studentUsns[studentUsns.length - 1]}).`;
        await pool.query(
            `INSERT INTO user_notifications (user_id, role, title, message, institution_id)
             VALUES ($1, 'teacher', 'Mentorship Assignment', $2, $3)`,
            [mentorId, notifyMsg, tenant]
        );

        res.status(200).json({ success: true, message: `Successfully mapped ${addedCount} mentees to teacher!` });
    } catch (err) {
        console.error("❌ Error allocating mentees:", err.message);
        res.status(500).json({ success: false, error: "Failed to map mentees." });
    }
});

// 📍 POST: Teacher Update Student Marks (CIE 1, CIE 2, CIE 3, SEE)
app.post('/api/teacher/update-marks', async (req, res) => {
    const { studentUsn, subjectCode, cie1, cie2, cie3, see, institutionId } = req.body;
    const tenant = institutionId || 'DR_AIT';

    if (!studentUsn || !subjectCode) {
        return res.status(400).json({ success: false, message: "Missing USN or Subject Code." });
    }

    try {
        await pool.query(
            `INSERT INTO student_marks (student_id, subject_code, subject_name, cie1, cie2, cie3, see, institution_id)
             VALUES ($1, $2, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (student_id, subject_code, institution_id)
             DO UPDATE SET
                cie1 = EXCLUDED.cie1,
                cie2 = EXCLUDED.cie2,
                cie3 = EXCLUDED.cie3,
                see = EXCLUDED.see`,
            [
                studentUsn, 
                subjectCode, 
                parseInt(cie1) || 0, 
                parseInt(cie2) || 0, 
                parseInt(cie3) || 0, 
                parseInt(see) || 0, 
                tenant
            ]
        );

        console.log(`📝 [MARKS SAVED]: Updated USN ${studentUsn} | Subject: ${subjectCode} | CIE1: ${cie1}, CIE2: ${cie2}, CIE3: ${cie3}, SEE: ${see}`);
        res.status(200).json({ success: true, message: `Marks updated successfully for ${studentUsn}!` });
    } catch (err) {
        console.error("❌ Marks Update Error:", err.message);
        res.status(500).json({ success: false, error: "Failed to update student marks." });
    }
});

// 📍 POST: Bulk Import Historical Marks
app.post('/api/admin/bulk-upload-marks', async (req, res) => {
    const { marksList, institutionId } = req.body; // Array of { studentUsn, subjectCode, subjectName, sem, cie1, cie2, cie3, see }
    const tenant = institutionId || 'DR_AIT';

    try {
        for (const item of marksList) {
            await pool.query(
                `INSERT INTO student_marks 
                    (student_id, subject_code, subject_name, semester_number, cie1, cie2, cie3, see, institution_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 ON CONFLICT (student_id, subject_code, semester_number, institution_id)
                 DO UPDATE SET cie1=EXCLUDED.cie1, cie2=EXCLUDED.cie2, cie3=EXCLUDED.cie3, see=EXCLUDED.see`,
                [
                    item.studentUsn, item.subjectCode, item.subjectName, parseInt(item.sem),
                    parseInt(item.cie1) || 0, parseInt(item.cie2) || 0, parseInt(item.cie3) || 0,
                    parseInt(item.see) || 0, tenant
                ]
            );
        }
        res.status(200).json({ success: true, message: "Past semester marks imported successfully!" });
    } catch (err) {
        console.error("❌ Bulk marks upload error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 📍 GET: Student Subject & Marks Metrics Across All Semesters
app.get('/api/auth/student-subject-metrics', async (req, res) => {
    const { studentId, institutionId } = req.query;
    const tenant = institutionId || 'DR_AIT';

    try {
        const query = `
            SELECT 
                m.subject_code,
                m.subject_name AS subject,
                COALESCE(m.semester_number, 1) AS semester_number,
                COALESCE(m.cie1, 0) AS cie1,
                COALESCE(m.cie2, 0) AS cie2,
                COALESCE(m.cie3, 0) AS cie3,
                COALESCE(m.see, 0) AS see,
                COUNT(a.id) AS conducted,
                COUNT(CASE WHEN a.student_id = $1 THEN 1 END) AS attended,
                (COUNT(a.id) - COUNT(CASE WHEN a.student_id = $1 THEN 1 END)) AS absent
            FROM student_marks m
            LEFT JOIN attendance_records a 
                   ON UPPER(a.subject_name) = UPPER(m.subject_code) 
                  AND a.institution_id = m.institution_id
            WHERE (m.student_id = $1 OR m.student_id = 'ALL')
              AND m.institution_id = $2
            GROUP BY m.subject_code, m.subject_name, m.semester_number, m.cie1, m.cie2, m.cie3, m.see
            ORDER BY m.semester_number ASC, m.subject_code ASC;
        `;

        const result = await pool.query(query, [studentId, tenant]);
        res.status(200).json({ ai_predictions: result.rows });
    } catch (err) {
        console.error("❌ Error fetching student metrics:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// 📍 GET: Fetch Parent Profile & Linked Student Name
app.get('/api/parent/profile', async (req, res) => {
    const { parentId, institutionId } = req.query;
    const tenant = institutionId || 'DR_AIT';
    
    try {
        const parentResult = await pool.query(
            `SELECT name, child_usn FROM users WHERE (usn = $1 OR phone_number = $1) AND institution_id = $2`,
            [parentId, tenant]
        );

        if (parentResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Parent record not found." });
        }

        const parent = parentResult.rows[0];
        let studentName = "Linked Ward";

        if (parent.child_usn) {
            const studentResult = await pool.query(
                `SELECT name FROM users WHERE usn = $1 AND institution_id = $2`,
                [parent.child_usn, tenant]
            );
            if (studentResult.rows.length > 0) {
                studentName = studentResult.rows[0].name;
            }
        }

        res.status(200).json({
            success: true,
            parentName: parent.name || "Guardian",
            childUsn: parent.child_usn || "N/A",
            studentName: studentName
        });
    } catch (err) {
        console.error("❌ Error fetching parent profile:", err.message);
        res.status(500).json({ success: false, error: "Failed to load parent profile." });
    }
});

module.exports = app;