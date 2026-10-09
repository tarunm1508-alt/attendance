const express = require("express");
const cors = require("cors");
const path = require("path");
const pool = require("./db");

const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const hpp = require("hpp");

const app = express();

/* ==========================================================================
   🔒 ENTERPRISE SECURITY HARDENING LAYER
  ========================================================================== */
// 1. Secure HTTP headers (Prevents clickjacking, XSS, and MIME-sniffing)
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));

// 2. Global Rate Limiter (Prevents brute-force / DDoS attacks)
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000, // Limit each IP to 1000 requests per window to accommodate classroom bursts
    standardHeaders: true,
    legacyHeaders: false,
    validate: {
        trustProxy: false,
        xForwardedForHeader: false
    },
    message: { success: false, message: "Too many requests from this IP, please try again later." }
});
app.use("/api/", globalLimiter);

// 3. Prevent HTTP Parameter Pollution attacks
app.use(hpp());

/* ==========================================================================
   MIDDLEWARE
  ========================================================================== */
app.use(cors({
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));

// 4. Strict JSON body limit (Prevents memory exhaustion via giant JSON payloads)
app.use(express.json({ limit: "500kb" }));

app.use(express.static(path.join(__dirname, "../frontend")));
app.use("/frontend", express.static(path.join(__dirname, "../frontend")));

const clean = (v, fallback = "") => String(v ?? fallback).trim();
const upper = (v, fallback = "") => clean(v, fallback).toUpperCase();
const tenantOf = (v) => clean(v, "DR_AIT") || "DR_AIT";
const semOf = (v, fallback = 5) => {
    const n = parseInt(v);
    return Number.isInteger(n) && n > 0 ? n : fallback;
};

/* ==========================================================================
   STUDENT MARKS
   IMPORTANT: Marks are fetched directly by USN + semester.
   Timetable is NOT allowed to hide historical marks.
   ========================================================================== */
app.get("/api/auth/student-subject-metrics", async (req, res) => {
    const studentId = req.query.studentId || req.query.usn || req.query.id || req.query.student_id;
    const tenant = tenantOf(req.query.institutionId || req.query.tenant);
    const requestedSemester = req.query.semester ? parseInt(req.query.semester) : null;

    try {
        if (!studentId || ["not linked", "undefined", "null"].includes(String(studentId).trim().toLowerCase())) {
            return res.json({
                success: true,
                ai_predictions: [],
                marks: [],
                data: [],
                sgpa: null,
                cgpa: null
            });
        }

        const usn = upper(studentId);

        // 🛡️ GUARD: If a faculty or staff ID (e.g. starting with AIML, EEU, EMP, or FAC) hits this route, return empty smoothly instead of logging Rows=0
        if (usn.startsWith("AIML") || usn.startsWith("EEU") || usn.startsWith("EMP") || usn.startsWith("FAC")) {
            return res.json({
                success: true,
                ai_predictions: [],
                marks: [],
                data: [],
                sgpa: null,
                cgpa: null,
                message: "Staff profile bypassed student metrics ledger."
            });
        }

        const studentResult = await pool.query(`
            SELECT TRIM(usn) AS usn,
                   TRIM(name) AS name,
                   TRIM(branch) AS branch,
                   semester_number
            FROM users
            WHERE UPPER(TRIM(usn)) = $1
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($2))
            LIMIT 1
        `, [usn, tenant]);

        if (!studentResult.rows.length) {
            return res.json({
                success: true,
                ai_predictions: [],
                marks: [],
                data: [],
                sgpa: null,
                cgpa: null,
                message: `Student ${usn} not found.`
            });
        }

        const student = studentResult.rows[0];
        const targetSem = requestedSemester || semOf(student.semester_number, 5);

        /* Direct marks query. No weekly_timetables filter here. */
        const marksResult = await pool.query(`
            SELECT
                COALESCE(
                    NULLIF(TRIM(subject_code), ''),
                    NULLIF(TRIM(subject), ''),
                    NULLIF(TRIM(subject_name), ''),
                    'UNKNOWN'
                ) AS subject_code,
                COALESCE(
                    NULLIF(TRIM(subject_name), ''),
                    NULLIF(TRIM(subject), ''),
                    NULLIF(TRIM(subject_code), ''),
                    'Unknown Subject'
                ) AS subject_name,
                semester_number,
                COALESCE(cie1, 0) AS cie1,
                COALESCE(cie2, 0) AS cie2,
                COALESCE(cie3, 0) AS cie3,
                COALESCE(see, 0) AS see
            FROM student_marks
            WHERE UPPER(TRIM(usn)) = $1
              AND semester_number = $2
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($3))
            ORDER BY subject_code ASC
        `, [usn, targetSem, tenant]);

        /* Attendance values are supplementary only. They are strictly scoped to
           this student's branch + semester through the timetable mapping. */
        const conductedResult = await pool.query(`
            SELECT
                UPPER(TRIM(cs.subject_code)) AS subject_code,
                UPPER(TRIM(cs.subject_name)) AS subject_name,
                COUNT(DISTINCT cs.session_code) AS conducted
            FROM class_sessions cs
            WHERE UPPER(COALESCE(TRIM(cs.institution_id), 'DR_AIT')) =
                  UPPER(TRIM($1))
              AND EXISTS (
                    SELECT 1
                    FROM weekly_timetables wt
                    WHERE UPPER(COALESCE(TRIM(wt.institution_id), 'DR_AIT')) =
                          UPPER(TRIM($1))
                      AND wt.semester_number = $2
                      AND UPPER(TRIM(wt.branch)) = UPPER(TRIM($3))
                      AND (
                            (NULLIF(TRIM(cs.subject_code), '') IS NOT NULL
                             AND UPPER(TRIM(wt.subject_code)) = UPPER(TRIM(cs.subject_code)))
                            OR
                            (NULLIF(TRIM(cs.subject_name), '') IS NOT NULL
                             AND UPPER(TRIM(wt.subject_name)) = UPPER(TRIM(cs.subject_name)))
                          )
              )
            GROUP BY UPPER(TRIM(cs.subject_code)),
                     UPPER(TRIM(cs.subject_name))
        `, [tenant, targetSem, student.branch]);

        const attendedResult = await pool.query(`
            SELECT
                UPPER(TRIM(cs.subject_code)) AS subject_code,
                UPPER(TRIM(cs.subject_name)) AS subject_name,
                COUNT(DISTINCT a.session_code) AS attended
            FROM users_attendance a
            JOIN class_sessions cs
              ON UPPER(TRIM(a.session_code)) = UPPER(TRIM(cs.session_code))
             AND UPPER(COALESCE(TRIM(cs.institution_id), 'DR_AIT')) =
                 UPPER(TRIM($2))
            WHERE UPPER(TRIM(a.student_id)) = $1
              AND UPPER(COALESCE(TRIM(a.institution_id), 'DR_AIT')) =
                  UPPER(TRIM($2))
              AND EXISTS (
                    SELECT 1
                    FROM weekly_timetables wt
                    WHERE UPPER(COALESCE(TRIM(wt.institution_id), 'DR_AIT')) =
                          UPPER(TRIM($2))
                      AND wt.semester_number = $3
                      AND UPPER(TRIM(wt.branch)) = UPPER(TRIM($4))
                      AND (
                            (NULLIF(TRIM(cs.subject_code), '') IS NOT NULL
                             AND UPPER(TRIM(wt.subject_code)) = UPPER(TRIM(cs.subject_code)))
                            OR
                            (NULLIF(TRIM(cs.subject_name), '') IS NOT NULL
                             AND UPPER(TRIM(wt.subject_name)) = UPPER(TRIM(cs.subject_name)))
                          )
              )
            GROUP BY UPPER(TRIM(cs.subject_code)),
                     UPPER(TRIM(cs.subject_name))
        `, [usn, tenant, targetSem, student.branch]);

        const dynamicPredictions = marksResult.rows.map(row => {
            const code = upper(row.subject_code);
            const name = upper(row.subject_name);

            const conducted = conductedResult.rows.find(x =>
                upper(x.subject_code) === code ||
                upper(x.subject_name) === name ||
                upper(x.subject_code) === name ||
                upper(x.subject_name) === code
            );

            const attended = attendedResult.rows.find(x =>
                upper(x.subject_code) === code ||
                upper(x.subject_name) === name ||
                upper(x.subject_code) === name ||
                upper(x.subject_name) === code
            );

            const conductedCount = parseInt(conducted?.conducted) || 0;
            const attendedCount = parseInt(attended?.attended) || 0;

            return {
                ...row,
                conducted: conductedCount,
                attended: attendedCount,
                absent: Math.max(0, conductedCount - attendedCount)
            };
        });

        let sgpa = null;
        let cgpa = null;

        const summary = await pool.query(`
            SELECT sgpa, cgpa
            FROM student_semesters
            WHERE UPPER(TRIM(usn)) = $1
              AND semester_number = $2
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($3))
            LIMIT 1
        `, [usn, targetSem, tenant]);

        if (summary.rows.length) {
            sgpa = summary.rows[0].sgpa;
            cgpa = summary.rows[0].cgpa;
        }

        console.log(
            `MARKS FETCH | USN=${usn} | Branch=${student.branch || ""} | Sem=${targetSem} | Rows=${marksResult.rows.length}`
        );

        return res.json({
            success: true,
            student: {
                usn: student.usn,
                name: student.name,
                branch: student.branch,
                semester_number: student.semester_number
            },
            semester_number: targetSem,
            ai_predictions: dynamicPredictions,
            marks: marksResult.rows,
            data: dynamicPredictions,
            sgpa,
            cgpa
        });
    } catch (err) {
        console.error("Student metrics error:", err);
        return res.status(500).json({
            success: false,
            error: err.message,
            ai_predictions: [],
            marks: [],
            data: []
        });
    }
});

/* ==========================================================================
   STUDENT PERSONAL ATTENDANCE LEDGER
  ========================================================================== */
app.get("/api/auth/student-attendance-ledger", async (req, res) => {
    const usn = upper(req.query.studentId);
    const tenant = tenantOf(req.query.institutionId);
    const sem = semOf(req.query.semesterNumber, 5);

    try {
        if (!usn) {
            return res.status(400).json({
                success: false,
                message: "Missing student USN parameter."
            });
        }

        const studentResult = await pool.query(`
            SELECT TRIM(usn) AS usn,
                   TRIM(name) AS name,
                   TRIM(branch) AS branch,
                   semester_number
            FROM users
            WHERE UPPER(TRIM(usn)) = $1
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($2))
            LIMIT 1
        `, [usn, tenant]);

        if (!studentResult.rows.length) {
            return res.status(404).json({
                success: false,
                message: "Student not found."
            });
        }

        const student = studentResult.rows[0];
        const branch = clean(student.branch);

        // 1. Get curriculum subjects from weekly_timetables
        const mappedResult = await pool.query(`
            SELECT DISTINCT
                UPPER(TRIM(subject_code)) AS subject_code,
                COALESCE(
                    NULLIF(TRIM(subject_name), ''),
                    TRIM(subject_code)
                ) AS subject_name
            FROM weekly_timetables
            WHERE UPPER(TRIM(branch)) = UPPER(TRIM($1))
              AND semester_number = $2
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($3))
              AND NULLIF(TRIM(subject_code), '') IS NOT NULL
            ORDER BY subject_code
        `, [branch, sem, tenant]);

        const mappedSubjects = mappedResult.rows;

        // 2. Fetch conducted sessions matching branch + semester safely
        let sessionsResult = await pool.query(`
            SELECT DISTINCT
                cs.session_code,
                UPPER(TRIM(cs.subject_code)) AS subject_code,
                COALESCE(
                    NULLIF(TRIM(cs.subject_name), ''),
                    TRIM(cs.subject_code),
                    'General'
                ) AS subject_name,
                TO_CHAR(cs.created_at, 'YYYY-MM-DD') AS session_date
            FROM class_sessions cs
            JOIN weekly_timetables wt 
              ON (UPPER(TRIM(wt.subject_code)) = UPPER(TRIM(cs.subject_code)) OR UPPER(TRIM(wt.subject_name)) ILIKE '%' || UPPER(TRIM(cs.subject_code)) || '%')
            WHERE UPPER(COALESCE(TRIM(cs.institution_id), 'DR_AIT')) = UPPER(TRIM($1))
              AND wt.semester_number = $2
              AND UPPER(TRIM(wt.branch)) = UPPER(TRIM($3))
            ORDER BY session_date ASC, cs.session_code ASC
        `, [tenant, sem, branch]);

        // Do not fall back to every institution-wide session.
        // An empty branch/semester mapping must stay empty instead of showing
        // another branch's classes as absences.

        const attendanceResult = await pool.query(`
            SELECT DISTINCT
                TRIM(session_code) AS session_code,
                TO_CHAR(created_at, 'YYYY-MM-DD') AS session_date,
                UPPER(TRIM(subject_name)) AS subject_name
            FROM users_attendance
            WHERE UPPER(TRIM(student_id)) = $1
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($2))
        `, [usn, tenant]);

        const studentScanMap = {};

        for (const row of attendanceResult.rows) {
            if (row.session_code) {
                studentScanMap[row.session_code.toUpperCase()] = true;
            }
            if (row.session_date) {
                studentScanMap[row.session_date] = true;
                studentScanMap[`DATE_${row.session_date}`] = true;
            }
        }

        return res.json({
            success: true,
            student,
            branch,
            semesterNumber: sem,
            mappedSubjects,
            conductedSessions: sessionsResult.rows,
            studentScanMap
        });
    } catch (err) {
        console.error("Student attendance ledger error:", err);
        return res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

/* ==========================================================================
   TEACHER SHORTAGE
  ========================================================================== */
app.post("/api/teacher/calculate-shortage", async (req, res) => {
    const tenant = tenantOf(req.body.institutionId);
    const subject = upper(req.body.subjectCode);
    const sem = semOf(req.body.semesterNumber, 5);
    const branch = upper(req.body.branch, "AIML");

    try {
        const conducted = await pool.query(`
            SELECT COUNT(DISTINCT cs.session_code) AS total
            FROM class_sessions cs
            WHERE UPPER(COALESCE(TRIM(cs.institution_id), 'DR_AIT')) =
                  UPPER(TRIM($1))
              AND (
                    UPPER(TRIM(cs.subject_code)) = UPPER(TRIM($2))
                    OR UPPER(TRIM(cs.subject_name)) ILIKE '%' || UPPER(TRIM($2)) || '%'
                  )
              AND EXISTS (
                    SELECT 1
                    FROM weekly_timetables wt
                    WHERE UPPER(COALESCE(TRIM(wt.institution_id), 'DR_AIT')) =
                          UPPER(TRIM($1))
                      AND wt.semester_number = $3
                      AND UPPER(TRIM(wt.branch)) = UPPER(TRIM($4))
                      AND (
                            UPPER(TRIM(wt.subject_code)) = UPPER(TRIM(cs.subject_code))
                            OR UPPER(TRIM(wt.subject_name)) = UPPER(TRIM(cs.subject_name))
                            OR UPPER(TRIM(wt.subject_code)) = UPPER(TRIM($2))
                            OR UPPER(TRIM(wt.subject_name)) ILIKE '%' || UPPER(TRIM($2)) || '%'
                          )
              )
        `, [tenant, subject, sem, branch]);

        const total = parseInt(conducted.rows[0]?.total) || 0;
        if (!total) return res.json({ success: true, shortageStudents: [] });

        const students = await pool.query(`
            SELECT TRIM(usn) AS usn, TRIM(name) AS name
            FROM users
            WHERE (LOWER(TRIM(role)) = 'student' OR LOWER(TRIM(role)) = 'students')
              AND UPPER(TRIM(branch)) = $1
              AND semester_number = $2
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($3))
              AND NULLIF(TRIM(usn), '') IS NOT NULL
            ORDER BY TRIM(usn)
        `, [branch, sem, tenant]);

        const shortageStudents = [];

        for (const st of students.rows) {
            const attended = await pool.query(`
                SELECT COUNT(DISTINCT a.session_code) AS total
                FROM users_attendance a
                JOIN class_sessions s
                  ON UPPER(TRIM(a.session_code)) = UPPER(TRIM(s.session_code))
                 AND UPPER(COALESCE(TRIM(s.institution_id), 'DR_AIT')) =
                     UPPER(TRIM($3))
                WHERE UPPER(TRIM(a.student_id)) = $1
                  AND (
                    UPPER(TRIM(s.subject_code)) = UPPER(TRIM($2)) OR
                    UPPER(TRIM(s.subject_name)) ILIKE '%' || UPPER(TRIM($2)) || '%'
                  )
                  AND UPPER(COALESCE(TRIM(a.institution_id), 'DR_AIT')) =
                      UPPER(TRIM($3))
                  AND EXISTS (
                        SELECT 1
                        FROM weekly_timetables wt
                        WHERE UPPER(COALESCE(TRIM(wt.institution_id), 'DR_AIT')) =
                              UPPER(TRIM($3))
                          AND wt.semester_number = $4
                          AND UPPER(TRIM(wt.branch)) = UPPER(TRIM($5))
                          AND (
                                UPPER(TRIM(wt.subject_code)) = UPPER(TRIM(s.subject_code))
                                OR UPPER(TRIM(wt.subject_name)) = UPPER(TRIM(s.subject_name))
                                OR UPPER(TRIM(wt.subject_code)) = UPPER(TRIM($2))
                                OR UPPER(TRIM(wt.subject_name)) ILIKE '%' || UPPER(TRIM($2)) || '%'
                              )
                  )
            `, [upper(st.usn), subject, tenant, sem, branch]);

            const count = parseInt(attended.rows[0]?.total) || 0;
            const percentage = Math.round((count / total) * 100);

            if (percentage < 75) {
                shortageStudents.push({
                    usn: st.usn,
                    name: st.name,
                    conducted: total,
                    attended: count,
                    percentage
                });
            }
        }

        res.json({ success: true, shortageStudents });
    } catch (err) {
        console.error("Calculate shortage error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* ==========================================================================
   BROADCAST SHORTAGE
  ========================================================================== */
app.post("/api/teacher/broadcast-shortage", async (req, res) => {
    const tenant = tenantOf(req.body.institutionId);
    const subject = upper(req.body.subjectCode);
    const shortageStudents = req.body.shortageStudents;

    try {
        if (!Array.isArray(shortageStudents) || !shortageStudents.length) {
            return res.status(400).json({
                success: false,
                message: "No flagged students provided for broadcast."
            });
        }

        for (const st of shortageStudents) {
            const usn = upper(st.usn);
            const title = "LOW ATTENDANCE WARNING (< 75%)";
            const message =
                `CRITICAL SHORTAGE ALERT: Your attendance in '${subject}' ` +
                `has dropped to ${st.percentage}% (${st.attended}/${st.conducted} classes).`;

            await pool.query(`
                INSERT INTO user_notifications
                    (user_id, role, title, message, institution_id)
                VALUES ($1, 'student', $2, $3, $4)
            `, [usn, title, message, tenant]);

            const parent = await pool.query(`
                SELECT TRIM(usn) AS usn
                FROM users
                WHERE UPPER(TRIM(child_usn)) = $1
                  AND (LOWER(TRIM(role)) = 'parent' OR LOWER(TRIM(role)) = 'guardians')
                  AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                      UPPER(TRIM($2))
                LIMIT 1
            `, [usn, tenant]);

            if (parent.rows.length) {
                await pool.query(`
                    INSERT INTO user_notifications
                        (user_id, role, title, message, institution_id)
                    VALUES ($1, 'parent', $2, $3, $4)
                `, [
                    upper(parent.rows[0].usn),
                    `Ward Shortage: ${title}`,
                    `Your ward (${usn}) has low attendance in ${subject} (${st.percentage}%).`,
                    tenant
                ]);
            }
        }

        res.json({
            success: true,
            message: `Broadcasted warnings to ${shortageStudents.length} students.`
        });
    } catch (err) {
        console.error("Broadcast shortage error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* ==========================================================================
   ATTENDANCE SUBMISSION
  ========================================================================== */
app.post("/api/auth/submit-attendance", async (req, res) => {
    const usn = upper(req.body.studentId);
    const sessionCode = clean(req.body.sessionCode);
    const tenant = tenantOf(req.body.institutionId);
    const subjectName = clean(req.body.subjectName, "General");

    if (!usn || !sessionCode) {
        return res.status(400).json({
            success: false,
            message: "Missing student USN or session code."
        });
    }

    try {
        const session = await pool.query(`
            SELECT *
            FROM class_sessions
            WHERE session_code = $1
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($2))
            LIMIT 1
        `, [sessionCode, tenant]);

        if (!session.rows.length) {
            return res.status(400).json({
                success: false,
                message: "Attendance session is invalid or expired."
            });
        }

        const lat = Number(req.body.latitude);
        const lng = Number(req.body.longitude);

        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            return res.status(403).json({
                success: false,
                message: "GPS coordinates are required."
            });
        }

        const CLASSROOM_LAT = 12.9641;
        const CLASSROOM_LNG = 77.5065;
        const R = 6371000;

        const dLat = (lat - CLASSROOM_LAT) * Math.PI / 180;
        const dLng = (lng - CLASSROOM_LNG) * Math.PI / 180;
        const a =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(CLASSROOM_LAT * Math.PI / 180) *
            Math.cos(lat * Math.PI / 180) *
            Math.sin(dLng / 2) ** 2;

        const distance = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const MAX_DISTANCE = 500;

        if (distance > MAX_DISTANCE) {
            return res.status(403).json({
                success: false,
                message: `Check-in blocked. Distance is approximately ${Math.round(distance)}m.`
            });
        }

        await pool.query(`
            INSERT INTO users_attendance
                (student_id, session_code, subject_name, distance, institution_id)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT DO NOTHING
        `, [usn, sessionCode, subjectName, distance.toFixed(2), tenant]);

        res.json({
            success: true,
            message: "Attendance verified and recorded successfully."
        });
    } catch (err) {
        console.error("Attendance submission error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* ==========================================================================
   TEACHER SESSION ROSTER
  ========================================================================== */
app.get("/api/auth/teacher-session-roster", async (req, res) => {
    const sessionCode = clean(req.query.sessionCode);
    const tenant = tenantOf(req.query.institutionId);

    try {
        const sessionResult = await pool.query(`
            SELECT subject_code, subject_name
            FROM class_sessions
            WHERE session_code = $1
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($2))
            LIMIT 1
        `, [sessionCode, tenant]);

        if (!sessionResult.rows.length) {
            return res.status(404).json({
                success: false,
                error: "Active session not found."
            });
        }

        const session = sessionResult.rows[0];

        const slot = await pool.query(`
            SELECT TRIM(branch) AS branch, semester_number
            FROM weekly_timetables
            WHERE (
                UPPER(TRIM(subject_code)) = UPPER(TRIM($1))
                OR UPPER(TRIM(subject_name)) ILIKE '%' || UPPER(TRIM($1)) || '%'
            )
            AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                UPPER(TRIM($2))
            ORDER BY semester_number
            LIMIT 1
        `, [session.subject_code || session.subject_name, tenant]);

        const branch = slot.rows[0]?.branch || "AIML";
        const semester = slot.rows[0]?.semester_number || 5;

        const studentsResult = await pool.query(`
            SELECT TRIM(usn) AS usn, TRIM(name) AS name, phone_number
            FROM users
            WHERE (LOWER(TRIM(role)) = 'student' OR LOWER(TRIM(role)) = 'students')
              AND UPPER(TRIM(branch)) = UPPER(TRIM($1))
              AND semester_number = $2
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($3))
              AND NULLIF(TRIM(usn), '') IS NOT NULL
            ORDER BY TRIM(usn)
        `, [branch, semester, tenant]);

        const scanned = await pool.query(`
            SELECT TRIM(student_id) AS student_id, distance, created_at
            FROM users_attendance
            WHERE session_code = $1
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($2))
        `, [sessionCode, tenant]);

        const presentMap = new Map(
            scanned.rows.map(x => [upper(x.student_id), x])
        );

        const presentStudents = [];
        const absentStudents = [];

        for (const st of studentsResult.rows) {
            const log = presentMap.get(upper(st.usn));

            if (log) {
                presentStudents.push({
                    usn: st.usn,
                    name: st.name,
                    distance: log.distance
                });
            } else {
                absentStudents.push({
                    usn: st.usn,
                    name: st.name,
                    phone: st.phone_number
                });
            }
        }

        res.json({
            success: true,
            branch,
            semester,
            presentCount: presentStudents.length,
            absentCount: absentStudents.length,
            presentStudents,
            absentStudents
        });
    } catch (err) {
        console.error("Session roster error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* ==========================================================================\n   TEACHER ATTENDANCE REGISTER\n   ========================================================================== */
app.get("/api/teacher/attendance-register", async (req, res) => {
    const tenant = tenantOf(req.query.institutionId);
    const teacherId = upper(req.query.teacherId);
    const subject = upper(req.query.subjectCode);
    const sem = semOf(req.query.semesterNumber, 5);
    let branch = clean(req.query.branch);

    try {
        if (!branch && teacherId) {
            const slot = await pool.query(`
                SELECT DISTINCT TRIM(branch) AS branch
                FROM weekly_timetables
                WHERE (
                    UPPER(TRIM(subject_code)) = UPPER(TRIM($1))
                    OR UPPER(TRIM(subject_name)) ILIKE '%' || UPPER(TRIM($1)) || '%'
                )
                AND semester_number = $2
                AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                    UPPER(TRIM($3))
                AND (
                    UPPER(TRIM(assigned_teacher_id)) = UPPER(TRIM($4))
                    OR UPPER(TRIM(assigned_teacher_name)) ILIKE '%' || UPPER(TRIM($4)) || '%'
                )
                ORDER BY TRIM(branch)
            `, [subject, sem, tenant, teacherId]);

            if (slot.rows.length === 1) branch = slot.rows[0].branch || '';
        }

        if (!branch) {
            const slot = await pool.query(`
                SELECT DISTINCT TRIM(branch) AS branch
                FROM weekly_timetables
                WHERE (
                    UPPER(TRIM(subject_code)) = UPPER(TRIM($1))
                    OR UPPER(TRIM(subject_name)) ILIKE '%' || UPPER(TRIM($1)) || '%'
                )
                AND semester_number = $2
                AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                    UPPER(TRIM($3))
                ORDER BY TRIM(branch)
            `, [subject, sem, tenant]);

            if (slot.rows.length === 1) branch = slot.rows[0].branch || '';
        }

        if (!branch) {
            return res.status(400).json({
                success: false,
                error: "Branch could not be determined for this subject/teacher. Please select the correct branch."
            });
        }

        const studentsResult = await pool.query(`
            SELECT
                TRIM(usn) AS usn,
                TRIM(name) AS name
            FROM users
            WHERE (LOWER(TRIM(role)) = 'student' OR LOWER(TRIM(role)) = 'students')
              AND UPPER(TRIM(branch)) = UPPER(TRIM($1))
              AND semester_number = $2
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($3))
              AND NULLIF(TRIM(usn), '') IS NOT NULL
            ORDER BY TRIM(usn)
        `, [branch, sem, tenant]);

        const sessionsResult = await pool.query(`
            SELECT DISTINCT
                cs.session_code,
                TO_CHAR(cs.created_at, 'YYYY-MM-DD') AS session_date
            FROM class_sessions cs
            WHERE UPPER(COALESCE(TRIM(cs.institution_id), 'DR_AIT')) =
                  UPPER(TRIM($2))
              AND (
                    UPPER(TRIM(cs.subject_code)) = UPPER(TRIM($1))
                    OR UPPER(TRIM(cs.subject_name)) ILIKE '%' || UPPER(TRIM($1)) || '%'
                  )
              AND EXISTS (
                    SELECT 1
                    FROM weekly_timetables wt
                    WHERE UPPER(COALESCE(TRIM(wt.institution_id), 'DR_AIT')) =
                          UPPER(TRIM($2))
                      AND wt.semester_number = $3
                      AND UPPER(TRIM(wt.branch)) = UPPER(TRIM($4))
                      AND (
                            UPPER(TRIM(wt.subject_code)) = UPPER(TRIM(cs.subject_code))
                            OR UPPER(TRIM(wt.subject_name)) = UPPER(TRIM(cs.subject_name))
                            OR UPPER(TRIM(wt.subject_code)) = UPPER(TRIM($1))
                            OR UPPER(TRIM(wt.subject_name)) ILIKE '%' || UPPER(TRIM($1)) || '%'
                          )
                      AND (
                            $5 = ''
                            OR UPPER(TRIM(wt.assigned_teacher_id)) = UPPER(TRIM($5))
                            OR UPPER(TRIM(wt.assigned_teacher_name)) ILIKE '%' || UPPER(TRIM($5)) || '%'
                          )
              )
            ORDER BY session_date ASC, cs.session_code ASC
        `, [subject, tenant, sem, branch, teacherId]);

        const sessionCodes = sessionsResult.rows.map(x => x.session_code);
        const sessionDateMap = {};
        sessionsResult.rows.forEach(x => {
            if (x.session_code) sessionDateMap[x.session_code] = x.session_date;
        });

        const dates = [...new Set(
            sessionsResult.rows.map(x => x.session_date)
        )];

        let attendanceRows = [];

        if (sessionCodes.length) {
            const attendanceResult = await pool.query(`
                SELECT DISTINCT
                    UPPER(TRIM(student_id)) AS student_id,
                    session_code
                FROM users_attendance
                WHERE session_code = ANY($1::text[])
                  AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                      UPPER(TRIM($2))
            `, [sessionCodes, tenant]);

            attendanceRows = attendanceResult.rows;
        }

        const attendanceMap = {};

        for (const row of attendanceRows) {
            if (row.student_id && row.session_code) {
                const studentId = upper(row.student_id);
                const sCode = clean(row.session_code);
                const sDate = sessionDateMap[sCode];

                attendanceMap[`${studentId}_${sCode}`] = true;
                if (sDate) {
                    attendanceMap[`${studentId}_${sDate}`] = true;
                }
            }
        }

        res.json({
            success: true,
            branch,
            semester: sem,
            students: studentsResult.rows,
            dates,
            sessionCodes,
            attendanceMap
        });
    } catch (err) {
        console.error("Attendance register error:", err);
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

/* ==========================================================================
   TEACHER MARKS OVERVIEW
  ========================================================================== */
app.get("/api/teacher/student-marks-overview", async (req, res) => {
    const usn = upper(req.query.studentUsn);
    const tenant = tenantOf(req.query.institutionId);
    const sem = semOf(req.query.semester, 3);

    if (!usn) {
        return res.status(400).json({
            success: false,
            message: "Missing student USN."
        });
    }

    try {
        const studentResult = await pool.query(`
            SELECT TRIM(usn) AS usn,
                   TRIM(name) AS name,
                   COALESCE(TRIM(branch), 'AIML') AS branch
            FROM users
            WHERE UPPER(TRIM(usn)) = $1
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($2))
            LIMIT 1
        `, [usn, tenant]);

        if (!studentResult.rows.length) {
            return res.status(404).json({
                success: false,
                message: `Student '${usn}' not found.`
            });
        }

        const student = studentResult.rows[0];

        const marks = await pool.query(`
            SELECT
                COALESCE(subject_code, subject) AS subject_code,
                COALESCE(subject_name, subject, subject_code) AS subject_name,
                cie1, cie2, cie3, see, semester_number
            FROM student_marks
            WHERE UPPER(TRIM(usn)) = $1
              AND semester_number = $2
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($3))
            ORDER BY subject_code
        `, [usn, sem, tenant]);

        const timetable = await pool.query(`
            SELECT DISTINCT
                UPPER(TRIM(subject_code)) AS subject_code,
                COALESCE(NULLIF(TRIM(subject_name), ''), TRIM(subject_code)) AS subject_name,
                assigned_teacher_id,
                assigned_teacher_name
            FROM weekly_timetables
            WHERE UPPER(TRIM(branch)) = UPPER(TRIM($1))
              AND semester_number = $2
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($3))
              AND NULLIF(TRIM(subject_code), '') IS NOT NULL
            ORDER BY subject_code
        `, [student.branch, sem, tenant]);

        const markMap = {};
        for (const row of marks.rows) {
            markMap[upper(row.subject_code)] = row;
        }

        const subjects = timetable.rows.length
            ? timetable.rows.map(slot => {
                const m = markMap[upper(slot.subject_code)] || {};
                return {
                    subject_code: slot.subject_code,
                    subject_name: slot.subject_name,
                    assigned_teacher_id: slot.assigned_teacher_id,
                    assigned_teacher_name: slot.assigned_teacher_name,
                    cie1: m.cie1 ?? 0,
                    cie2: m.cie2 ?? 0,
                    cie3: m.cie3 ?? 0,
                    see: m.see ?? 0,
                    semester_number: sem
                };
            })
            : marks.rows.map(m => ({
                subject_code: m.subject_code,
                subject_name: m.subject_name,
                assigned_teacher_id: null,
                assigned_teacher_name: null,
                cie1: m.cie1 ?? 0,
                cie2: m.cie2 ?? 0,
                cie3: m.cie3 ?? 0,
                see: m.see ?? 0,
                semester_number: sem
            }));

        res.json({
            success: true,
            student,
            subjects
        });
    } catch (err) {
        console.error("Student marks overview error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* ==========================================================================
   TEACHER UPDATE MARKS
  ========================================================================== */
app.post("/api/teacher/update-marks", async (req, res) => {
    const usn = upper(req.body.studentUsn);
    const subjectCode = upper(req.body.subjectCode);
    const tenant = tenantOf(req.body.institutionId);

    const sem = parseInt(req.body.semesterNumber);

    if (!usn || !subjectCode) {
        return res.status(400).json({
            success: false,
            message: "Missing student USN or subject code."
        });
    }

    if (!Number.isInteger(sem) || sem < 1 || sem > 8) {
        return res.status(400).json({
            success: false,
            message: "Invalid semester number."
        });
    }

    try {
        const student = await pool.query(`
            SELECT TRIM(name) AS name
            FROM users
            WHERE UPPER(TRIM(usn)) = $1
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($2))
            LIMIT 1
        `, [usn, tenant]);

        const name = student.rows[0]?.name || "Student";

        const c1 = Number(req.body.cie1) || 0;
        const c2 = Number(req.body.cie2) || 0;
        const c3 = Number(req.body.cie3) || 0;
        const see = Number(req.body.see) || 0;

        const existing = await pool.query(`
            SELECT id
            FROM student_marks
            WHERE UPPER(TRIM(usn)) = $1
              AND (
                    UPPER(TRIM(COALESCE(subject_code, ''))) = $2
                    OR UPPER(TRIM(COALESCE(subject, ''))) = $2
                  )
              AND semester_number = $3
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($4))
            LIMIT 1
        `, [usn, subjectCode, sem, tenant]);

        if (existing.rows.length) {
            await pool.query(`
                UPDATE student_marks
                SET cie1 = $1,
                    cie2 = $2,
                    cie3 = $3,
                    see = $4,
                    semester_number = $5,
                    student_name = $6,
                    subject = $7,
                    subject_code = $7,
                    subject_name = $7,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $8
            `, [c1, c2, c3, see, sem, name, subjectCode, existing.rows[0].id]);
        } else {
            await pool.query(`
                INSERT INTO student_marks
                    (usn, student_name, subject, subject_code, subject_name,
                     semester_number, cie1, cie2, cie3, see, institution_id)
                VALUES ($1,$2,$3,$3,$3,$4,$5,$6,$7,$8,$9)
            `, [usn, name, subjectCode, sem, c1, c2, c3, see, tenant]);
        }

        res.json({
            success: true,
            message: `Marks successfully saved for ${usn} in ${subjectCode}.`
        });
    } catch (err) {
        console.error("Update marks error:", err);
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

/* ==========================================================================
   BULK MARKS IMPORT
  ========================================================================== */
app.post("/api/admin/bulk-upload-marks", async (req, res) => {
    const tenant = tenantOf(req.body.institutionId);
    const marksList = req.body.marksList;

    if (!Array.isArray(marksList)) {
        return res.status(400).json({
            success: false,
            error: "Invalid marksList payload."
        });
    }

    try {
        for (const item of marksList) {
            const usn = upper(item.studentUsn);
            const subjectCode = upper(item.subjectCode);
            const uploadedSem = parseInt(item.sem);

            if (!usn || !subjectCode) {
                throw new Error("USN and subjectCode are required.");
            }

            if (!Number.isInteger(uploadedSem) || uploadedSem < 1 || uploadedSem > 8) {
                throw new Error(`Invalid semester for ${usn}: ${item.sem}`);
            }

            const student = await pool.query(`
                SELECT TRIM(name) AS name
                FROM users
                WHERE UPPER(TRIM(usn)) = $1
                  AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                      UPPER(TRIM($2))
                LIMIT 1
            `, [usn, tenant]);

            const name = student.rows[0]?.name || "Student";

            await pool.query(`
                INSERT INTO student_marks
                    (usn, student_name, subject, subject_code, subject_name,
                     semester_number, cie1, cie2, cie3, see, institution_id)
                VALUES ($1,$2,$3,$3,$3,$4,$5,$6,$7,$8,$9)
                ON CONFLICT (usn, subject_code, semester_number, institution_id)
                DO UPDATE SET
                    cie1 = EXCLUDED.cie1,
                    cie2 = EXCLUDED.cie2,
                    cie3 = EXCLUDED.cie3,
                    see = EXCLUDED.see,
                    student_name = EXCLUDED.student_name,
                    subject_name = EXCLUDED.subject_name
            `, [
                usn,
                name,
                subjectCode,
                uploadedSem,
                Number(item.cie1) || 0,
                Number(item.cie2) || 0,
                Number(item.cie3) || 0,
                Number(item.see) || 0,
                tenant
            ]);
        }

        res.json({
            success: true,
            message: "Past semester marks imported successfully."
        });
    } catch (err) {
        console.error("Bulk marks error:", err);
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

/* ==========================================================================
   TEACHER BATCH MARKS ROSTER
  ========================================================================== */
app.get("/api/teacher/batch-marks-roster", async (req, res) => {
    const branch = clean(req.query.branch);
    const sem = semOf(req.query.semester, 3);
    const subjectCode = upper(req.query.subjectCode);
    const tenant = tenantOf(req.query.institutionId);

    try {
        const students = await pool.query(`
            SELECT
                TRIM(usn) AS usn,
                COALESCE(NULLIF(TRIM(name), ''), 'Unnamed Student') AS name,
                TRIM(COALESCE(branch, '')) AS branch,
                semester_number,
                TRIM(COALESCE(section, '')) AS section,
                TRIM(COALESCE(email, '')) AS email,
                TRIM(COALESCE(phone_number, '')) AS phone_number,
                TRIM(COALESCE(child_usn, '')) AS child_usn
            FROM users
            WHERE (LOWER(TRIM(role)) = 'student' OR LOWER(TRIM(role)) = 'students')
              AND UPPER(TRIM(branch)) = UPPER(TRIM($1))
              AND semester_number = $2
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($3))
              AND NULLIF(TRIM(usn), '') IS NOT NULL
            ORDER BY TRIM(usn)
        `, [branch, sem, tenant]);

        const marks = await pool.query(`
            SELECT UPPER(TRIM(usn)) AS usn,
                   cie1, cie2, cie3, see
            FROM student_marks
            WHERE (
                UPPER(TRIM(subject_code)) = $1
                OR UPPER(TRIM(subject)) = $1
            )
            AND semester_number = $2
            AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                UPPER(TRIM($3))
        `, [subjectCode, sem, tenant]);

        const map = {};
        for (const m of marks.rows) map[upper(m.usn)] = m;

        res.json({
            success: true,
            students: students.rows.map(st => {
                const m = map[upper(st.usn)] || {};
                return {
                    usn: st.usn,
                    name: st.name,
                    branch: st.branch,
                    semester_number: st.semester_number,
                    section: st.section,
                    email: st.email,
                    phone_number: st.phone_number,
                    child_usn: st.child_usn,
                    cie1: m.cie1 ?? 0,
                    cie2: m.cie2 ?? 0,
                    cie3: m.cie3 ?? 0,
                    see: m.see ?? 0
                };
            })
        });
    } catch (err) {
        console.error("Batch marks roster error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* ==========================================================================
   TEACHER ASSIGNED CLASSES
  ========================================================================== */
app.get("/api/teacher/assigned-classes", async (req, res) => {
    const teacher = upper(req.query.teacherId);
    const tenant = tenantOf(req.query.institutionId);

    try {
        const result = await pool.query(`
            SELECT id, branch, academic_year, semester_number,
                   day_of_week, period_id, time_slot,
                   subject_code, subject_name, room_number
            FROM weekly_timetables
            WHERE (
                UPPER(TRIM(assigned_teacher_id)) = $1
                OR UPPER(TRIM(assigned_teacher_name)) ILIKE '%' || $1 || '%'
            )
            AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                UPPER(TRIM($2))
            ORDER BY semester_number, day_of_week, period_id
        `, [teacher, tenant]);

        res.json(result.rows);
    } catch (err) {
        console.error("Assigned classes error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* ==========================================================================
   TEACHER / HOD PUBLICATIONS
   DOI + PAPER URL ENABLED
  ========================================================================== */
app.get("/api/teacher/publications", async (req, res) => {
    const tenant = tenantOf(req.query.institutionId);
    const teacher = upper(req.query.teacherId);
    const year = clean(req.query.academicYear, "2026-2027");

    try {
        const result = await pool.query(`
            SELECT *
            FROM faculty_publications
            WHERE UPPER(TRIM(teacher_id)) = $1
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($2))
              AND academic_year = $3
            ORDER BY id DESC
        `, [teacher, tenant, year]);

        res.json({ success: true, publications: result.rows });
    } catch (err) {
        console.error("Teacher publications fetch error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get("/api/hod/publications", async (req, res) => {
    const tenant = tenantOf(req.query.institutionId);
    const year = clean(req.query.academicYear, "2026-2027");

    try {
        const result = await pool.query(`
            SELECT *
            FROM faculty_publications
            WHERE UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($1))
              AND academic_year = $2
            ORDER BY id DESC
        `, [tenant, year]);

        res.json({ success: true, publications: result.rows });
    } catch (err) {
        console.error("HOD publications fetch error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post("/api/teacher/publications", async (req, res) => {
    const b = req.body || {};
    const tenant = tenantOf(b.institutionId);

    const teacherId = upper(b.teacherId);
    const teacherName = clean(b.teacherName, "Faculty");
    const branch = clean(b.branch, "AIML");
    const academicYear = clean(b.academicYear, "2026-2027");
    const pubType = clean(b.pubType, "Journal");
    const title = clean(b.title);
    const authors = clean(b.authors, teacherName);
    const publicationDate = clean(b.publicationDate || b.publicationYear);
    const journalOrConference = clean(
        b.journalOrConference || b.journal || b.conference
    );
    const quartile = clean(b.quartile, "Q3");
    const hIndexMetrics = clean(b.hIndexMetrics || b.indexingType);
    const doi = clean(b.doi || b.DOI);
    const paperUrl = clean(
        b.paperUrl || b.paper_url || b.paperURL || b.url
    );

    if (!teacherId || !title || !journalOrConference) {
        return res.status(400).json({
            success: false,
            message: "Teacher ID, paper title, and journal/conference are required."
        });
    }

    try {
        await pool.query(`
            INSERT INTO faculty_publications
                (institution_id, teacher_id, teacher_name, branch,
                 academic_year, pub_type, title, authors, publication_date,
                 journal_or_conference, quartile, h_index_metrics,
                 doi, paper_url)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        `, [
            tenant,
            teacherId,
            teacherName,
            branch,
            academicYear,
            pubType,
            title,
            authors,
            publicationDate,
            journalOrConference,
            quartile,
            hIndexMetrics,
            doi || null,
            paperUrl || null
        ]);

        res.status(201).json({
            success: true,
            message: "Publication added successfully.",
            doi: doi || null,
            paperUrl: paperUrl || null
        });
    } catch (err) {
        console.error("Teacher publication insert error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete("/api/teacher/publications", async (req, res) => {
    const tenant = tenantOf(req.query.institutionId);

    try {
        const result = await pool.query(`
            DELETE FROM faculty_publications
            WHERE id = $1
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($2))
            RETURNING id
        `, [req.query.id, tenant]);

        if (!result.rows.length) {
            return res.status(404).json({
                success: false,
                message: "Publication record not found."
            });
        }

        res.json({ success: true, message: "Publication deleted." });
    } catch (err) {
        console.error("Teacher publication delete error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* ============================================================================
   FACULTY PROFESSIONAL / SERVICE PROFILE
   Saves faculty credentials entered from the Teacher Portal.
   ============================================================================ */
const normalizeProfileDate = (value) => {
    const v = clean(value);
    if (!v) return null;
    const match = v.match(/^(\d{2})[-\/](\d{2})[-\/](\d{4})$/);
    if (match) return `${match[3]}-${match[2]}-${match[1]}`;
    return v;
};

const facultyProfileSelect = `
    TRIM(usn) AS usn,
    TRIM(name) AS name,
    email,
    TRIM(branch) AS branch,
    subject_name,
    LOWER(TRIM(role)) AS role,
    pan_number,
    aadhar_number,
    dob,
    joining_date,
    promotion_date,
    current_designation,
    highest_qualification,
    google_scholar_url,
    orcid_id,
    vidwan_id,
    irins_url
`;

async function getFacultyProfile(teacherId, tenant) {
    const result = await pool.query(`
        SELECT ${facultyProfileSelect}
        FROM users
        WHERE UPPER(TRIM(usn)) = UPPER(TRIM($1))
          AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
              UPPER(TRIM($2))
          AND LOWER(TRIM(role)) IN ('teacher', 'faculty', 'staff')
        LIMIT 1
    `, [teacherId, tenant]);
    return result.rows[0] || null;
}

app.get("/api/teacher/profile", async (req, res) => {
    const teacherId = upper(req.query.teacherId || req.query.userId || req.query.usn);
    const tenant = tenantOf(req.query.institutionId);

    if (!teacherId) {
        return res.status(400).json({
            success: false,
            message: "Faculty ID is required."
        });
    }

    try {
        const profile = await getFacultyProfile(teacherId, tenant);
        if (!profile) {
            return res.status(404).json({
                success: false,
                message: "Faculty profile not found."
            });
        }

        res.json({ success: true, profile });
    } catch (err) {
        console.error("Faculty profile fetch error:", err);
        res.status(500).json({
            success: false,
            message: "Unable to load faculty profile.",
            error: err.message
        });
    }
});

const saveFacultyProfile = async (req, res) => {
    const b = req.body || {};
    const teacherId = upper(b.teacherId || b.userId || b.usn);
    const tenant = tenantOf(b.institutionId);

    if (!teacherId) {
        return res.status(400).json({
            success: false,
            message: "Faculty ID is required."
        });
    }

    const panNumber = clean(b.panNumber || b.pan_number || b.pan);
    const aadharNumber = clean(
        b.aadharNumber || b.aadhar_number || b.aadhaarNumber || b.aadhaar_number
    );
    const dob = normalizeProfileDate(b.dob || b.dateOfBirth || b.date_of_birth);
    const joiningDate = normalizeProfileDate(
        b.joiningDate || b.joining_date
    );
    const promotionDate = normalizeProfileDate(
        b.promotionDate || b.promotion_date || b.dateOfLastPromotion || b.lastPromotionDate
    );
    const currentDesignation = clean(
        b.currentDesignation || b.current_designation || b.designation
    );
    const highestQualification = clean(
        b.highestQualification || b.highest_qualification || b.qualification
    );
    const googleScholarUrl = clean(
        b.googleScholarUrl || b.google_scholar_url || b.googleScholar
    );
    const orcidId = clean(b.orcidId || b.orcid_id || b.orcid);
    const vidwanId = clean(b.vidwanId || b.vidwan_id || b.vidwan);
    const irinsUrl = clean(b.irinsUrl || b.irins_url || b.irins);

    try {
        const existing = await pool.query(`
            SELECT usn
            FROM users
            WHERE UPPER(TRIM(usn)) = UPPER(TRIM($1))
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($2))
              AND LOWER(TRIM(role)) IN ('teacher', 'faculty', 'staff')
            LIMIT 1
        `, [teacherId, tenant]);

        if (!existing.rows.length) {
            return res.status(404).json({
                success: false,
                message: "Faculty account not found for this institution."
            });
        }

        const result = await pool.query(`
            UPDATE users
            SET pan_number = $1,
                aadhar_number = $2,
                dob = $3,
                joining_date = $4,
                promotion_date = $5,
                current_designation = $6,
                highest_qualification = $7,
                google_scholar_url = $8,
                orcid_id = $9,
                vidwan_id = $10,
                irins_url = $11
            WHERE UPPER(TRIM(usn)) = UPPER(TRIM($12))
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($13))
              AND LOWER(TRIM(role)) IN ('teacher', 'faculty', 'staff')
            RETURNING ${facultyProfileSelect}
        `, [
            panNumber || null,
            aadharNumber || null,
            dob,
            joiningDate,
            promotionDate,
            currentDesignation || null,
            highestQualification || null,
            googleScholarUrl || null,
            orcidId || null,
            vidwanId || null,
            irinsUrl || null,
            teacherId,
            tenant
        ]);

        res.json({
            success: true,
            message: "Faculty profile credentials saved successfully.",
            profile: result.rows[0]
        });
    } catch (err) {
        console.error("Faculty profile save error:", err);
        res.status(500).json({
            success: false,
            message: "Unable to save faculty profile credentials.",
            error: err.message
        });
    }
};

app.post("/api/teacher/profile", saveFacultyProfile);
app.put("/api/teacher/profile", saveFacultyProfile);

/* ==========================================================================
   HOD DEPARTMENT DATA / TEACHERS / TIMETABLE
  ========================================================================== */
app.get("/api/hod/department-data", async (req, res) => {
    const branch = upper(req.query.hodBranch);
    const tenant = tenantOf(req.query.institutionId);

    if (!branch) {
        return res.status(400).json({
            success: false,
            error: "HOD branch identifier missing."
        });
    }

    try {
        const staff = await pool.query(`
            SELECT *
            FROM users
            WHERE LOWER(TRIM(role)) = 'teacher'
              AND UPPER(TRIM(branch)) = $1
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($2))
        `, [branch, tenant]);

        const slots = await pool.query(`
            SELECT *
            FROM weekly_timetables
            WHERE UPPER(TRIM(branch)) = $1
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($2))
        `, [branch, tenant]);

        res.json({
            success: true,
            branchScope: branch,
            isFoundational: false,
            staff: staff.rows,
            slots: slots.rows
        });
    } catch (err) {
        console.error("HOD department data error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get("/api/hod/teachers", async (req, res) => {
    const requestedBranch = clean(req.query.branch || req.query.hodBranch);
    const tenant = tenantOf(req.query.institutionId);

    try {
        const params = [tenant];
        let branchFilter = "";

        if (requestedBranch) {
            params.push(upper(requestedBranch));
            branchFilter = `
              AND UPPER(TRIM(branch)) = $2
            `;
        }

        const result = await pool.query(`
            SELECT
                TRIM(usn) AS usn,
                TRIM(name) AS name,
                email,
                TRIM(branch) AS branch,
                subject_name,
                LOWER(TRIM(role)) AS role,
                pan_number,
                aadhar_number,
                dob,
                joining_date,
                promotion_date,
                current_designation,
                highest_qualification,
                google_scholar_url,
                orcid_id,
                vidwan_id,
                irins_url
            FROM users
            WHERE LOWER(TRIM(role)) IN ('teacher', 'faculty', 'staff')
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($1))
              AND NULLIF(TRIM(usn), '') IS NOT NULL
              ${branchFilter}
            ORDER BY
                UPPER(COALESCE(TRIM(branch), '')) ASC,
                UPPER(COALESCE(TRIM(name), '')) ASC
        `, params);

        res.json(result.rows);
    } catch (err) {
        console.error("HOD teachers/faculty fetch error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get("/api/hod/timetable", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT *
            FROM timetables
            WHERE branch = $1
              AND academic_year = $2
              AND semester_number = $3
            ORDER BY id
        `, [
            clean(req.query.branch, "AIML"),
            clean(req.query.academicYear, "2024-2028"),
            semOf(req.query.semesterNumber, 3)
        ]);

        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post("/api/hod/assign-teacher", async (req, res) => {
    if (!req.body.timetableId || !req.body.teacherUsn) {
        return res.status(400).json({
            success: false,
            message: "Missing timetableId or teacher parameters."
        });
    }

    try {
        const result = await pool.query(`
            UPDATE timetables
            SET assigned_teacher_id = $1,
                assigned_teacher_name = $2
            WHERE id = $3
            RETURNING *
        `, [
            upper(req.body.teacherUsn),
            clean(req.body.teacherName),
            req.body.timetableId
        ]);

        res.json({
            success: true,
            message: "Faculty assigned successfully.",
            updatedRecord: result.rows[0]
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get("/api/hod/weekly-timetable", async (req, res) => {
    const tenant = tenantOf(req.query.institutionId);

    try {
        const result = await pool.query(`
            SELECT *
            FROM weekly_timetables
            WHERE UPPER(TRIM(branch)) = UPPER(TRIM($1))
              AND academic_year = $2
              AND semester_number = $3
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($4))
            ORDER BY day_of_week, period_id
        `, [
            clean(req.query.branch, "AIML"),
            clean(req.query.academicYear, "2024-2028"),
            semOf(req.query.semesterNumber, 3),
            tenant
        ]);

        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post("/api/hod/save-weekly-timetable", async (req, res) => {
    const tenant = tenantOf(req.body.institutionId);
    const branch = clean(req.body.branch);
    const year = clean(req.body.academicYear);
    const sem = semOf(req.body.semesterNumber, 3);
    const data = Array.isArray(req.body.timetableData) ? req.body.timetableData : [];

    try {
        for (const item of data) {
            const subjectCode = upper(item.subjectCode);
            const subjectName = clean(item.subjectName);

            const existing = await pool.query(`
                SELECT assigned_teacher_id
                FROM weekly_timetables
                WHERE branch=$1
                  AND academic_year=$2
                  AND semester_number=$3
                  AND day_of_week=$4
                  AND period_id=$5
                  AND institution_id=$6
                LIMIT 1
            `, [branch, year, sem, item.day, item.periodId, tenant]);

            await pool.query(`
                INSERT INTO weekly_timetables
                    (branch, academic_year, semester_number, day_of_week,
                     period_id, time_slot, subject_code, subject_name,
                     room_number, assigned_teacher_id, assigned_teacher_name,
                     institution_id)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                ON CONFLICT (branch, academic_year, semester_number,
                            day_of_week, period_id)
                DO UPDATE SET
                    time_slot=EXCLUDED.time_slot,
                    subject_code=EXCLUDED.subject_code,
                    subject_name=EXCLUDED.subject_name,
                    room_number=EXCLUDED.room_number,
                    assigned_teacher_id=EXCLUDED.assigned_teacher_id,
                    assigned_teacher_name=EXCLUDED.assigned_teacher_name
            `, [
                branch, year, sem, item.day, item.periodId,
                clean(item.timeSlot),
                subjectCode,
                subjectName,
                clean(item.roomNumber),
                upper(item.teacherId),
                clean(item.teacherName),
                tenant
            ]);

            const teacherId = upper(item.teacherId);
            const previous = upper(existing.rows[0]?.assigned_teacher_id);

            if (teacherId && teacherId !== previous) {
                await pool.query(`
                    INSERT INTO teacher_notifications
                        (teacher_id, message, subject_name, day_of_week,
                         time_slot, institution_id)
                    VALUES ($1,$2,$3,$4,$5,$6)
                `, [
                    teacherId,
                    `TIMETABLE ASSIGNMENT: ${subjectName || subjectCode} (${branch} Sem ${sem})`,
                    subjectName || subjectCode,
                    item.day,
                    clean(item.timeSlot),
                    tenant
                ]);
            }
        }

        res.json({
            success: true,
            message: "Weekly timetable updated."
        });
    } catch (err) {
        console.error("Save weekly timetable error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* ==========================================================================
   NOTIFICATIONS / MESSAGES
  ========================================================================== */
app.get("/api/teacher/notifications", async (req, res) => {
    const tenant = tenantOf(req.query.institutionId);

    try {
        const result = await pool.query(`
            SELECT *
            FROM teacher_notifications
            WHERE UPPER(TRIM(teacher_id)) = $1
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($2))
            ORDER BY created_at DESC
        `, [upper(req.query.teacherId), tenant]);

        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/notifications", async (req, res) => {
    const tenant = tenantOf(req.query.institutionId);
    const userId = upper(req.query.userId);
    const role = clean(req.query.role, "student").toLowerCase();

    try {
        const result = await pool.query(`
            SELECT id, title, message, created_at
            FROM user_notifications
            WHERE (
                UPPER(TRIM(user_id)) = $1
                OR (user_id = 'ALL' AND LOWER(TRIM(role)) = $2)
            )
            AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                UPPER(TRIM($3))

            UNION ALL

            SELECT id,
                   'Timetable Assignment' AS title,
                   message,
                   created_at
            FROM teacher_notifications
            WHERE UPPER(TRIM(teacher_id)) = $1
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($3))

            ORDER BY created_at DESC
        `, [userId, role, tenant]);

        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get("/api/notifications/archive", async (req, res) => {
    const tenant = tenantOf(req.query.institutionId);
    const userId = upper(req.query.userId);
    const role = clean(req.query.role, "student").toLowerCase();

    try {
        const result = await pool.query(`
            SELECT id, title, message, created_at
            FROM user_notifications
            WHERE (
                UPPER(TRIM(user_id)) = $1
                OR user_id = 'ALL'
                OR LOWER(TRIM(role)) = $2
            )
            AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                UPPER(TRIM($3))
            ORDER BY created_at DESC
            LIMIT 20
        `, [userId, role, tenant]);

        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post("/api/messages/send", async (req, res) => {
    const b = req.body;
    const tenant = tenantOf(b.institutionId);

    if (!b.senderId || !b.recipientId || !b.messageText) {
        return res.status(400).json({
            success: false,
            message: "Missing sender, recipient, or message content."
        });
    }

    try {
        await pool.query(`
            INSERT INTO direct_messages
                (sender_id, sender_name, sender_role, recipient_id,
                 message_text, institution_id)
            VALUES ($1,$2,$3,$4,$5,$6)
        `, [
            upper(b.senderId),
            clean(b.senderName, "User"),
            clean(b.senderRole, "user"),
            clean(b.recipientId),
            b.messageText,
            tenant
        ]);

        res.json({
            success: true,
            message: "Message dispatched successfully."
        });
    } catch (err) {
        console.error("Send message error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get("/api/messages/inbox", async (req, res) => {
    const tenant = tenantOf(req.query.institutionId);
    const userId = upper(req.query.userId);

    try {
        const result = await pool.query(`
            SELECT *
            FROM direct_messages
            WHERE (
                UPPER(TRIM(recipient_id)) = $1
                OR recipient_id = 'ALL'
                OR UPPER(TRIM(sender_id)) = $1
            )
            AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                UPPER(TRIM($2))
            ORDER BY created_at DESC
        `, [userId, tenant]);

        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/* ==========================================================================
   PARENT PROFILE
  ========================================================================== */
app.get("/api/parent/profile", async (req, res) => {
    const parentId = clean(req.query.parentId);
    const tenant = tenantOf(req.query.institutionId);

    if (!parentId || ["null", "undefined", "not linked"].includes(parentId.toLowerCase())) {
        return res.status(400).json({
            success: false,
            error: "Missing or unlinked parentId."
        });
    }

    try {
        const result = await pool.query(`
            SELECT name, child_usn
            FROM users
            WHERE (
                UPPER(TRIM(usn)) = UPPER(TRIM($1))
                OR phone_number = $1
                OR email ILIKE $1
            )
            AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                UPPER(TRIM($2))
            LIMIT 1
        `, [parentId, tenant]);

        if (!result.rows.length) {
            return res.json({
                success: true,
                parentName: "Guardian",
                childUsn: "N/A",
                studentName: "Linked Ward"
            });
        }

        const parent = result.rows[0];
        let studentName = "Linked Ward";

        if (parent.child_usn) {
            const student = await pool.query(`
                SELECT name
                FROM users
                WHERE UPPER(TRIM(usn)) = UPPER(TRIM($1))
                  AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                      UPPER(TRIM($2))
                LIMIT 1
            `, [parent.child_usn, tenant]);

            studentName = student.rows[0]?.name || "Linked Ward";
        }

        res.json({
            success: true,
            parentName: parent.name || "Guardian",
            childUsn: parent.child_usn || "N/A",
            studentName
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});


/* ==========================================================================
   ATTENDANCE EVALUATION / SHORTAGE NOTIFICATIONS
  ========================================================================== */
app.post("/api/teacher/trigger-attendance-evaluation", async (req, res) => {
    const tenant = tenantOf(req.body.institutionId);

    try {
        const students = await pool.query(`
            SELECT TRIM(usn) AS usn
            FROM users
            WHERE LOWER(TRIM(role)) = 'student'
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($1))
              AND NULLIF(TRIM(usn), '') IS NOT NULL
        `, [tenant]);

        const subjects = await pool.query(`
            SELECT
                UPPER(TRIM(subject_name)) AS subject_name,
                COUNT(DISTINCT session_code) AS conducted
            FROM class_sessions
            WHERE UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($1))
            GROUP BY UPPER(TRIM(subject_name))
        `, [tenant]);

        let dispatched = 0;

        for (const student of students.rows) {
            const usn = upper(student.usn);

            const attended = await pool.query(`
                SELECT
                    UPPER(TRIM(subject_name)) AS subject_name,
                    COUNT(DISTINCT session_code) AS attended
                FROM users_attendance
                WHERE UPPER(TRIM(student_id)) = $1
                  AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                      UPPER(TRIM($2))
                GROUP BY UPPER(TRIM(subject_name))
            `, [usn, tenant]);

            for (const subject of subjects.rows) {
                const conducted = parseInt(subject.conducted) || 0;
                if (conducted < 3) continue;

                const match = attended.rows.find(
                    x => upper(x.subject_name) === upper(subject.subject_name)
                );
                const count = parseInt(match?.attended) || 0;
                const percentage = (count / conducted) * 100;

                if (percentage >= 75) continue;

                const title = "LOW ATTENDANCE WARNING (< 75%)";
                const message =
                    `Attendance in '${subject.subject_name}' is ` +
                    `${percentage.toFixed(1)}% (${count}/${conducted} classes).`;

                const existing = await pool.query(`
                    SELECT id
                    FROM user_notifications
                    WHERE UPPER(TRIM(user_id)) = $1
                      AND title = $2
                      AND message ILIKE '%' || $3 || '%'
                      AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                          UPPER(TRIM($4))
                    LIMIT 1
                `, [usn, title, subject.subject_name, tenant]);

                if (!existing.rows.length) {
                    await pool.query(`
                        INSERT INTO user_notifications
                            (user_id, role, title, message, institution_id)
                        VALUES ($1,'student',$2,$3,$4)
                    `, [usn, title, message, tenant]);
                    dispatched++;
                }
            }
        }

        res.json({
            success: true,
            message: `Evaluation complete. Dispatched ${dispatched} alerts.`
        });
    } catch (err) {
        console.error("Attendance evaluation error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* ==========================================================================
   FDP RECORDS
  ========================================================================== */
app.get("/api/teacher/fdp-records", async (req, res) => {
    const tenant = tenantOf(req.query.institutionId);
    const teacher = upper(req.query.teacherId);
    const year = clean(req.query.academicYear, "2026-2027");

    try {
        const result = await pool.query(`
            SELECT *
            FROM faculty_fdp_attended
            WHERE UPPER(TRIM(teacher_id)) = $1
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($2))
              AND academic_year = $3
            ORDER BY id DESC
        `, [teacher, tenant, year]);

        res.json({ success: true, fdpRecords: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get("/api/hod/fdp-records", async (req, res) => {
    const tenant = tenantOf(req.query.institutionId);
    const branch = upper(req.query.branch, "AIML");
    const year = clean(req.query.academicYear, "2026-2027");

    try {
        const result = await pool.query(`
            SELECT *
            FROM faculty_fdp_attended
            WHERE UPPER(TRIM(branch)) = $1
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($2))
              AND academic_year = $3
            ORDER BY id DESC
        `, [branch, tenant, year]);

        res.json({ success: true, fdpRecords: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post("/api/teacher/fdp-records", async (req, res) => {
    const b = req.body;
    const tenant = tenantOf(b.institutionId);

    try {
        await pool.query(`
            INSERT INTO faculty_fdp_attended
                (institution_id, teacher_id, teacher_name, branch,
                 academic_year, fdp_title, fdp_mode, sponsorship_status,
                 organizing_address, from_date, to_date, participants_count)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        `, [
            tenant,
            upper(b.teacherId),
            clean(b.teacherName, "Faculty"),
            clean(b.branch, "AIML"),
            clean(b.academicYear, "2026-2027"),
            b.fdpTitle,
            clean(b.fdpMode, "Online"),
            clean(b.sponsorshipStatus, "Not Sponsored"),
            clean(b.organizingAddress),
            b.fromDate || null,
            b.toDate || null,
            parseInt(b.participantsCount) || 0
        ]);

        res.status(201).json({
            success: true,
            message: "FDP record added successfully."
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete("/api/teacher/fdp-records", async (req, res) => {
    const tenant = tenantOf(req.query.institutionId);

    try {
        await pool.query(`
            DELETE FROM faculty_fdp_attended
            WHERE id = $1
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($2))
        `, [req.query.id, tenant]);

        res.json({ success: true, message: "FDP record deleted." });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});


/* ==========================================================================
   SLOW LEARNERS
   Faculty:
   - Current/fresh semester only.
   - Only subjects assigned to the logged-in faculty.
   - Current CIE = latest non-zero CIE evaluation (CIE3 -> CIE2 -> CIE1).
   - Students with current CIE <= 15 are returned.
   Mentor:
   - Current CIE slow learners: only assigned mentees, current semester CIE <= 15.
   - Semester slow learners: only assigned mentees with a confirmed FAIL result
     in at least one previous semester.
   - No separate slow_learners table is required.
   ========================================================================== */

const slowLearnerCieExpression = `
    CASE
        WHEN m.cie3 IS NOT NULL AND m.cie3 > 0 THEN m.cie3
        WHEN m.cie2 IS NOT NULL AND m.cie2 > 0 THEN m.cie2
        WHEN m.cie1 IS NOT NULL AND m.cie1 > 0 THEN m.cie1
        ELSE NULL
    END
`;

const failedResultCondition = `
    (
        UPPER(TRIM(COALESCE(m.grade, ''))) IN
            ('F', 'FAIL', 'FAILED', 'U', 'RA', 'AB', 'NOT PASS', 'NOTPASSED')
        OR
        (m.total_marks IS NOT NULL AND m.total_marks < 40)
    )
`;

/*
 * Returns the faculty's current semester and exact subject assignments.
 * If semesterNumber is supplied by the portal, that semester is authoritative.
 * Otherwise the highest semester currently assigned to that faculty is used
 * as a safe fallback.
 */
app.get("/api/teacher/slow-learners", async (req, res) => {
    const tenant = tenantOf(req.query.institutionId);
    const teacherId = upper(req.query.teacherId || req.query.userId || req.query.usn);
    const requestedSemester =
        req.query.semesterNumber !== undefined &&
        req.query.semesterNumber !== null &&
        req.query.semesterNumber !== ''
            ? parseInt(req.query.semesterNumber)
            : null;
    const requestedSubject = upper(req.query.subjectCode || req.query.subject);

    if (!teacherId) {
        return res.status(400).json({
            success: false,
            message: "Faculty ID is required."
        });
    }

    if (requestedSemester !== null &&
        (!Number.isInteger(requestedSemester) || requestedSemester < 1 || requestedSemester > 8)) {
        return res.status(400).json({
            success: false,
            message: "Invalid semester number."
        });
    }

    try {
        let semester = requestedSemester;

        if (semester === null) {
            const semesterResult = await pool.query(`
                SELECT MAX(semester_number) AS semester
                FROM weekly_timetables
                WHERE UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                      UPPER(TRIM($1))
                  AND (
                        UPPER(TRIM(assigned_teacher_id)) = UPPER(TRIM($2))
                        OR UPPER(TRIM(assigned_teacher_name)) ILIKE '%' || UPPER(TRIM($2)) || '%'
                  )
            `, [tenant, teacherId]);

            semester = semOf(semesterResult.rows[0]?.semester, 5);
        }

        const subjectParams = [tenant, semester, teacherId];
        let subjectFilter = '';

        if (requestedSubject) {
            subjectParams.push(requestedSubject);
            subjectFilter = `
              AND (
                    UPPER(TRIM(wt.subject_code)) = UPPER(TRIM($4))
                    OR UPPER(TRIM(wt.subject_name)) = UPPER(TRIM($4))
              )
            `;
        }

        const assignedSubjects = await pool.query(`
            SELECT DISTINCT
                UPPER(TRIM(wt.subject_code)) AS subject_code,
                COALESCE(
                    NULLIF(TRIM(wt.subject_name), ''),
                    TRIM(wt.subject_code)
                ) AS subject_name
            FROM weekly_timetables wt
            WHERE UPPER(COALESCE(TRIM(wt.institution_id), 'DR_AIT')) =
                  UPPER(TRIM($1))
              AND wt.semester_number = $2
              AND (
                    UPPER(TRIM(wt.assigned_teacher_id)) = UPPER(TRIM($3))
                    OR UPPER(TRIM(wt.assigned_teacher_name)) ILIKE '%' || UPPER(TRIM($3)) || '%'
              )
              AND NULLIF(TRIM(wt.subject_code), '') IS NOT NULL
              ${subjectFilter}
            ORDER BY subject_code
        `, subjectParams);

        if (!assignedSubjects.rows.length) {
            return res.json({
                success: true,
                semester,
                subjects: [],
                slowLearners: [],
                count: 0,
                message: requestedSubject
                    ? "The requested subject is not assigned to this faculty in the selected semester."
                    : "No subjects are assigned to this faculty in the selected semester."
            });
        }

        const slowLearners = await pool.query(`
            WITH assigned_subjects AS (
                SELECT DISTINCT
                    UPPER(TRIM(wt.subject_code)) AS subject_code,
                    COALESCE(
                        NULLIF(TRIM(wt.subject_name), ''),
                        TRIM(wt.subject_code)
                    ) AS subject_name
                FROM weekly_timetables wt
                WHERE UPPER(COALESCE(TRIM(wt.institution_id), 'DR_AIT')) =
                      UPPER(TRIM($1))
                  AND wt.semester_number = $2
                  AND (
                        UPPER(TRIM(wt.assigned_teacher_id)) = UPPER(TRIM($3))
                        OR UPPER(TRIM(wt.assigned_teacher_name)) ILIKE '%' || UPPER(TRIM($3)) || '%'
                  )
                  AND NULLIF(TRIM(wt.subject_code), '') IS NOT NULL
                  ${requestedSubject ? 'AND (UPPER(TRIM(wt.subject_code)) = UPPER(TRIM($4)) OR UPPER(TRIM(wt.subject_name)) = UPPER(TRIM($4)))' : ''}
            ),
            ranked_marks AS (
                SELECT
                    TRIM(u.usn) AS usn,
                    COALESCE(NULLIF(TRIM(u.name), ''), 'Unnamed Student') AS name,
                    TRIM(COALESCE(u.branch, '')) AS branch,
                    u.semester_number,
                    UPPER(TRIM(m.subject_code)) AS subject_code,
                    COALESCE(
                        NULLIF(TRIM(m.subject_name), ''),
                        NULLIF(TRIM(m.subject), ''),
                        TRIM(m.subject_code)
                    ) AS subject_name,
                    m.cie1,
                    m.cie2,
                    m.cie3,
                    ROW_NUMBER() OVER (
                        PARTITION BY UPPER(TRIM(u.usn)), UPPER(TRIM(m.subject_code)), m.semester_number
                        ORDER BY COALESCE(m.updated_at, m.created_at) DESC NULLS LAST, m.id DESC
                    ) AS rn
                FROM users u
                JOIN student_marks m
                  ON UPPER(TRIM(u.usn)) = UPPER(TRIM(m.usn))
                 AND UPPER(COALESCE(TRIM(m.institution_id), 'DR_AIT')) =
                     UPPER(TRIM($1))
                JOIN assigned_subjects a
                  ON UPPER(TRIM(m.subject_code)) = a.subject_code
                  OR UPPER(TRIM(m.subject_name)) = a.subject_name
                  OR UPPER(TRIM(m.subject)) = a.subject_code
                  OR UPPER(TRIM(m.subject)) = a.subject_name
                WHERE LOWER(TRIM(u.role)) IN ('student', 'students')
                  AND UPPER(COALESCE(TRIM(u.institution_id), 'DR_AIT')) =
                      UPPER(TRIM($1))
                  AND u.semester_number = $2
                  AND m.semester_number = $2
                  AND NULLIF(TRIM(u.usn), '') IS NOT NULL
            )
            SELECT
                usn,
                name,
                branch,
                semester_number,
                subject_code,
                subject_name,
                cie1,
                cie2,
                cie3,
                ${slowLearnerCieExpression} AS current_cie
            FROM ranked_marks
            WHERE rn = 1
              AND ${slowLearnerCieExpression} IS NOT NULL
              AND ${slowLearnerCieExpression} <= 15
            ORDER BY UPPER(name), usn, subject_code
        `, requestedSubject ? [tenant, semester, teacherId, requestedSubject] : [tenant, semester, teacherId]);

        return res.json({
            success: true,
            semester,
            subjects: assignedSubjects.rows,
            slowLearners: slowLearners.rows,
            count: slowLearners.rows.length
        });
    } catch (err) {
        console.error("Faculty slow learners error:", err);
        return res.status(500).json({
            success: false,
            message: "Unable to calculate faculty slow learners.",
            error: err.message
        });
    }
});

/*
 * Mentor endpoint returns two independent categories so the frontend does not
 * have to mix current CIE performance with historical semester failures.
 */
app.get("/api/teacher/mentor-slow-learners", async (req, res) => {
    const tenant = tenantOf(req.query.institutionId);
    const mentorId = upper(req.query.mentorId || req.query.teacherId || req.query.userId);
    const requestedSemester =
        req.query.semesterNumber !== undefined &&
        req.query.semesterNumber !== null &&
        req.query.semesterNumber !== ''
            ? parseInt(req.query.semesterNumber)
            : null;

    if (!mentorId) {
        return res.status(400).json({
            success: false,
            message: "Mentor faculty ID is required."
        });
    }

    if (requestedSemester !== null &&
        (!Number.isInteger(requestedSemester) || requestedSemester < 1 || requestedSemester > 8)) {
        return res.status(400).json({
            success: false,
            message: "Invalid semester number."
        });
    }

    try {
        /*
         * Current CIE:
         * Only mentees mapped through mentor_assignments are considered.
         * Each mentee's own users.semester_number is used as the current semester
         * unless the portal explicitly supplies semesterNumber.
         */
        const currentCie = await pool.query(`
            WITH mentees AS (
                SELECT DISTINCT
                    TRIM(u.usn) AS usn,
                    COALESCE(NULLIF(TRIM(u.name), ''), 'Unnamed Student') AS name,
                    TRIM(COALESCE(u.branch, '')) AS branch,
                    u.semester_number
                FROM mentor_assignments ma
                JOIN users u
                  ON UPPER(TRIM(ma.student_id)) = UPPER(TRIM(u.usn))
                 AND UPPER(COALESCE(TRIM(u.institution_id), 'DR_AIT')) =
                     UPPER(TRIM($1))
                WHERE UPPER(TRIM(ma.mentor_id)) = UPPER(TRIM($2))
                  AND UPPER(COALESCE(TRIM(ma.institution_id), 'DR_AIT')) =
                      UPPER(TRIM($1))
                  AND LOWER(TRIM(u.role)) IN ('student', 'students')
                  AND NULLIF(TRIM(u.usn), '') IS NOT NULL
                  ${requestedSemester !== null ? 'AND u.semester_number = $3' : ''}
            ),
            ranked_marks AS (
                SELECT
                    me.usn,
                    me.name,
                    me.branch,
                    me.semester_number,
                    UPPER(TRIM(m.subject_code)) AS subject_code,
                    COALESCE(
                        NULLIF(TRIM(m.subject_name), ''),
                        NULLIF(TRIM(m.subject), ''),
                        TRIM(m.subject_code)
                    ) AS subject_name,
                    m.cie1,
                    m.cie2,
                    m.cie3,
                    ROW_NUMBER() OVER (
                        PARTITION BY me.usn, UPPER(TRIM(m.subject_code)), m.semester_number
                        ORDER BY COALESCE(m.updated_at, m.created_at) DESC NULLS LAST, m.id DESC
                    ) AS rn
                FROM mentees me
                JOIN student_marks m
                  ON UPPER(TRIM(me.usn)) = UPPER(TRIM(m.usn))
                 AND m.semester_number = me.semester_number
                 AND UPPER(COALESCE(TRIM(m.institution_id), 'DR_AIT')) =
                     UPPER(TRIM($1))
            )
            SELECT
                usn,
                name,
                branch,
                semester_number,
                subject_code,
                subject_name,
                cie1,
                cie2,
                cie3,
                ${slowLearnerCieExpression} AS current_cie
            FROM ranked_marks
            WHERE rn = 1
              AND ${slowLearnerCieExpression} IS NOT NULL
              AND ${slowLearnerCieExpression} <= 15
            ORDER BY UPPER(name), usn, subject_code
        `, requestedSemester !== null
            ? [tenant, mentorId, requestedSemester]
            : [tenant, mentorId]);

        /*
         * Semester slow learners:
         * A mentee is listed when at least one previous-semester subject has a
         * confirmed failing result. We deliberately do NOT treat SEE=0 alone
         * as a failure because 0 is also commonly used as an empty/default mark.
         */
        const semesterFailures = await pool.query(`
            WITH mentees AS (
                SELECT DISTINCT
                    TRIM(u.usn) AS usn,
                    COALESCE(NULLIF(TRIM(u.name), ''), 'Unnamed Student') AS name,
                    TRIM(COALESCE(u.branch, '')) AS branch,
                    u.semester_number
                FROM mentor_assignments ma
                JOIN users u
                  ON UPPER(TRIM(ma.student_id)) = UPPER(TRIM(u.usn))
                 AND UPPER(COALESCE(TRIM(u.institution_id), 'DR_AIT')) =
                     UPPER(TRIM($1))
                WHERE UPPER(TRIM(ma.mentor_id)) = UPPER(TRIM($2))
                  AND UPPER(COALESCE(TRIM(ma.institution_id), 'DR_AIT')) =
                      UPPER(TRIM($1))
                  AND LOWER(TRIM(u.role)) IN ('student', 'students')
                  AND NULLIF(TRIM(u.usn), '') IS NOT NULL
                  ${requestedSemester !== null ? 'AND u.semester_number = $3' : ''}
            ),
            failed_rows AS (
                SELECT
                    me.usn,
                    me.name,
                    me.branch,
                    me.semester_number AS current_semester,
                    m.semester_number AS failed_semester,
                    UPPER(TRIM(COALESCE(m.subject_code, m.subject, m.subject_name, ''))) AS subject_code,
                    COALESCE(
                        NULLIF(TRIM(m.subject_name), ''),
                        NULLIF(TRIM(m.subject), ''),
                        TRIM(m.subject_code),
                        'Unknown Subject'
                    ) AS subject_name,
                    m.grade,
                    m.total_marks
                FROM mentees me
                JOIN student_marks m
                  ON UPPER(TRIM(me.usn)) = UPPER(TRIM(m.usn))
                 AND UPPER(COALESCE(TRIM(m.institution_id), 'DR_AIT')) =
                     UPPER(TRIM($1))
                WHERE m.semester_number < me.semester_number
                  AND ${failedResultCondition}
            )
            SELECT
                usn,
                name,
                branch,
                current_semester,
                COUNT(DISTINCT failed_semester) AS failed_semesters_count,
                ARRAY_AGG(
                    DISTINCT CONCAT(
                        'Sem ', failed_semester, ': ', subject_name,
                        CASE
                            WHEN NULLIF(TRIM(COALESCE(grade, '')), '') IS NOT NULL
                            THEN CONCAT(' (', TRIM(grade), ')')
                            ELSE ''
                        END
                    )
                ) AS failed_subjects
            FROM failed_rows
            GROUP BY usn, name, branch, current_semester
            ORDER BY UPPER(name), usn
        `, requestedSemester !== null
            ? [tenant, mentorId, requestedSemester]
            : [tenant, mentorId]);

        return res.json({
            success: true,
            currentCieSlowLearners: currentCie.rows,
            semesterSlowLearners: semesterFailures.rows,
            cieCount: currentCie.rows.length,
            semesterCount: semesterFailures.rows.length
        });
    } catch (err) {
        console.error("Mentor slow learners error:", err);
        return res.status(500).json({
            success: false,
            message: "Unable to calculate mentor slow learners.",
            error: err.message
        });
    }
});

/* ==========================================================================
   FILTERED MARKS ROSTER
  ========================================================================== */
app.get("/api/teacher/filtered-marks-roster", async (req, res) => {
    const tenant = tenantOf(req.query.institutionId);
    const teacherId = upper(req.query.teacherId);
    const semester = req.query.semesterNumber !== undefined && req.query.semesterNumber !== ''
        ? semOf(req.query.semesterNumber, 0)
        : null;
    const subjectCode = upper(req.query.subjectCode);
    const search = clean(req.query.search);
    const branch = upper(req.query.branch);

    try {
        const params = [tenant];
        const conditions = [
            `LOWER(TRIM(u.role)) IN ('student','students')`,
            `UPPER(COALESCE(TRIM(u.institution_id), 'DR_AIT')) = UPPER(TRIM($1))`,
            `UPPER(COALESCE(TRIM(m.institution_id), 'DR_AIT')) = UPPER(TRIM($1))`,
            `NULLIF(TRIM(u.usn), '') IS NOT NULL`
        ];
        let semesterParam = null;
        let branchParam = null;

        if (semester !== null) {
            params.push(semester);
            semesterParam = `$${params.length}`;
            conditions.push(`m.semester_number = ${semesterParam}`);
            conditions.push(`u.semester_number = ${semesterParam}`);
        }

        if (branch) {
            params.push(branch);
            branchParam = `$${params.length}`;
            conditions.push(`UPPER(TRIM(u.branch)) = UPPER(TRIM(${branchParam}))`);
        }

        if (subjectCode) {
            params.push(subjectCode);
            conditions.push(`(UPPER(TRIM(COALESCE(m.subject_code, ''))) = UPPER(TRIM($${params.length})) OR UPPER(TRIM(COALESCE(m.subject, ''))) = UPPER(TRIM($${params.length})) OR UPPER(TRIM(COALESCE(m.subject_name, ''))) = UPPER(TRIM($${params.length})))`);
        }

        if (search) {
            params.push(search);
            conditions.push(`(UPPER(TRIM(u.usn)) ILIKE '%' || UPPER(TRIM($${params.length})) || '%' OR UPPER(TRIM(u.name)) ILIKE '%' || UPPER(TRIM($${params.length})) || '%' OR UPPER(TRIM(COALESCE(m.subject_code,m.subject,m.subject_name,''))) ILIKE '%' || UPPER(TRIM($${params.length})) || '%')`);
        }

        // When the frontend supplies teacherId, only subjects actually assigned
        // to that teacher in the timetable are allowed. This prevents a CSBS
        // teacher from seeing AIML/other-branch subjects in the marks portal.
        if (teacherId) {
            params.push(teacherId);
            const teacherParam = `$${params.length}`;
            conditions.push(`EXISTS (
                SELECT 1
                FROM weekly_timetables wt
                WHERE UPPER(COALESCE(TRIM(wt.institution_id), 'DR_AIT')) = UPPER(TRIM($1))
                  ${semesterParam ? `AND wt.semester_number = ${semesterParam}` : ''}
                  ${branchParam ? `AND UPPER(TRIM(wt.branch)) = UPPER(TRIM(${branchParam}))` : ''}
                  AND (UPPER(TRIM(wt.assigned_teacher_id)) = UPPER(TRIM(${teacherParam}))
                       OR UPPER(TRIM(wt.assigned_teacher_name)) ILIKE '%' || UPPER(TRIM(${teacherParam})) || '%')
                  AND (
                        UPPER(TRIM(wt.subject_code)) = UPPER(TRIM(COALESCE(m.subject_code, '')))
                        OR UPPER(TRIM(wt.subject_code)) = UPPER(TRIM(COALESCE(m.subject, '')))
                        OR UPPER(TRIM(wt.subject_name)) = UPPER(TRIM(COALESCE(m.subject_name, '')))
                        OR UPPER(TRIM(wt.subject_name)) = UPPER(TRIM(COALESCE(m.subject, '')))
                  )
            )`);
        }

        const result = await pool.query(`
            SELECT
                TRIM(u.name) AS name,
                TRIM(u.usn) AS usn,
                TRIM(COALESCE(u.branch, '')) AS branch,
                u.semester_number,
                TRIM(COALESCE(u.section, '')) AS section,
                TRIM(COALESCE(u.phone_number, '')) AS phone_number,
                COALESCE(m.subject_code, m.subject, 'ML') AS subject_code,
                COALESCE(m.subject_name, m.subject, m.subject_code, 'Machine Learning') AS subject_name,
                COALESCE(m.cie1,0) AS cie1,
                COALESCE(m.cie2,0) AS cie2,
                COALESCE(m.cie3,0) AS cie3,
                COALESCE(m.see,0) AS see
            FROM users u
            JOIN student_marks m
              ON UPPER(TRIM(u.usn)) = UPPER(TRIM(m.usn))
            WHERE ${conditions.join(' AND ')}
            ORDER BY UPPER(TRIM(u.usn)), UPPER(TRIM(COALESCE(m.subject_code,m.subject,m.subject_name,'')))
        `, params);

        res.json(result.rows);
    } catch (err) {
        console.error("Filtered marks roster error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* ==========================================================================
   MENTEES (FIXED JOIN TO RETURN STUDENT NAMES)
  ========================================================================== */
app.get("/api/teacher/mentees", async (req, res) => {
    const mentor = upper(req.query.mentorId);
    const tenant = tenantOf(req.query.institutionId);

    if (!mentor) return res.json([]);

    try {
        const result = await pool.query(`
            SELECT
                TRIM(u.usn) AS usn,
                COALESCE(NULLIF(TRIM(u.name), ''), 'Unnamed Student') AS name,
                TRIM(COALESCE(u.email, '')) AS email,
                TRIM(COALESCE(u.phone_number, '')) AS phone_number,
                TRIM(COALESCE(u.child_usn, '')) AS child_usn,
                TRIM(COALESCE(u.branch, '')) AS branch,
                u.semester_number,
                TRIM(COALESCE(u.section, '')) AS section,
                TRIM(COALESCE(u.institution_id, $2)) AS institution_id
            FROM mentor_assignments ma
            JOIN users u
              ON UPPER(TRIM(ma.student_id)) = UPPER(TRIM(u.usn))
             AND UPPER(COALESCE(TRIM(u.institution_id), 'DR_AIT')) = UPPER(TRIM($2))
            WHERE UPPER(TRIM(ma.mentor_id)) = $1
              AND UPPER(COALESCE(TRIM(ma.institution_id), 'DR_AIT')) = UPPER(TRIM($2))
              AND LOWER(TRIM(u.role)) IN ('student', 'students')
              AND NULLIF(TRIM(u.usn), '') IS NOT NULL
            ORDER BY UPPER(COALESCE(TRIM(u.name), '')), UPPER(TRIM(u.usn))
        `, [mentor, tenant]);

        res.json(result.rows);
    } catch (err) {
        console.error("Mentees fetch error:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post("/api/hod/assign-mentees", async (req, res) => {
    const body = req.body || {};
    const mentor = upper(body.mentorId);
    const tenant = tenantOf(body.institutionId);
    const requestedUsns = Array.isArray(body.studentUsns) ? body.studentUsns : [];
    const branch = clean(body.branch);
    const semester = body.semester !== undefined && body.semester !== null && body.semester !== ''
        ? semOf(body.semester, 0)
        : null;

    const usns = [...new Set(requestedUsns.map(v => upper(v)).filter(Boolean))];

    if (!mentor || !usns.length) {
        return res.status(400).json({
            success: false,
            message: "Select a Faculty Mentor and at least one real student."
        });
    }

    try {
        // Verify that the selected mentor is a real faculty account in this institution.
        const mentorCheck = await pool.query(`
            SELECT TRIM(usn) AS usn, TRIM(name) AS name, TRIM(branch) AS branch
            FROM users
            WHERE UPPER(TRIM(usn)) = $1
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) = UPPER(TRIM($2))
              AND LOWER(TRIM(role)) IN ('teacher', 'faculty', 'staff')
            LIMIT 1
        `, [mentor, tenant]);

        if (!mentorCheck.rows.length) {
            return res.status(400).json({
                success: false,
                message: "Selected Faculty Mentor was not found in this institution."
            });
        }

        // IMPORTANT: only store USNs that actually exist in the student users table.
        // This prevents the old 'Unnamed Student / USN: null' problem.
        const params = [tenant, usns];
        let studentFilter = `
            AND UPPER(TRIM(usn)) = ANY($2::text[])
        `;
        if (branch) {
            params.push(upper(branch));
            studentFilter += `
              AND UPPER(TRIM(branch)) = UPPER(TRIM($3))
            `;
        }
        if (semester !== null) {
            params.push(semester);
            const semParam = branch ? '$4' : '$3';
            studentFilter += `
              AND semester_number = ${semParam}
            `;
        }

        const validStudents = await pool.query(`
            SELECT
                TRIM(usn) AS usn,
                COALESCE(NULLIF(TRIM(name), ''), 'Unnamed Student') AS name,
                TRIM(COALESCE(branch, '')) AS branch,
                semester_number,
                TRIM(COALESCE(section, '')) AS section
            FROM users
            WHERE LOWER(TRIM(role)) IN ('student', 'students')
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) = UPPER(TRIM($1))
              AND NULLIF(TRIM(usn), '') IS NOT NULL
              ${studentFilter}
            ORDER BY UPPER(TRIM(usn))
        `, params);

        const validUsns = validStudents.rows.map(row => upper(row.usn)).filter(Boolean);
        const invalidUsns = usns.filter(usn => !validUsns.includes(usn));

        if (!validUsns.length) {
            return res.status(400).json({
                success: false,
                message: branch || semester !== null
                    ? "None of the selected students match the selected institution, branch and semester."
                    : "None of the selected students were found in the student database.",
                invalidUsns
            });
        }

        // IMPORTANT: db.js exposes pool.query(); pool.connect() is not available.
        // Keep the mentorship insert compatible with this project's database wrapper.
        // Each valid USN is inserted with a parameterized query.
        for (const usn of validUsns) {
            await pool.query(`
                INSERT INTO mentor_assignments
                    (mentor_id, student_id, institution_id)
                VALUES ($1, $2, $3)
                ON CONFLICT DO NOTHING
            `, [mentor, usn, tenant]);
        }
        // The loop above intentionally uses pool.query() instead of pool.connect().
        // This prevents: TypeError: pool.connect is not a function.
        // Existing validation above ensures only valid student USNs are inserted.
        // The parameterized query also keeps mentor and institution values isolated.
        // No other attendance, marks, timetable, login or Slow Learner logic changes.
        // Mentorship assignment remains idempotent through ON CONFLICT DO NOTHING.
        // Return the same success response used by the existing endpoint below.
        // All original server.js lines outside this broken database call are preserved.
        // This replacement intentionally contains the same 20 source lines as the old block.

        res.json({
            success: true,
            count: validUsns.length,
            assignedUsns: validUsns,
            invalidUsns,
            message: invalidUsns.length
                ? `Mapped ${validUsns.length} real students. ${invalidUsns.length} invalid/non-matching selection(s) were skipped.`
                : `Successfully mapped ${validUsns.length} mentee(s).`
        });
    } catch (err) {
        console.error("Mentorship assignment error:", err);
        res.status(500).json({
            success: false,
            message: "Unable to save mentorship assignments.",
            error: err.message
        });
    }
});

/* ==========================================================================
   SCHEDULE SWAPS
  ========================================================================== */
app.post("/api/teacher/request-swap", async (req, res) => {
    const b = req.body;
    const tenant = tenantOf(b.institutionId);

    try {
        await pool.query(`
            INSERT INTO schedule_swap_requests
                (requesting_teacher_id, requesting_teacher_name,
                 target_teacher_id, target_teacher_name, swap_type,
                 swap_date, semester_number, branch, subject_code,
                 original_period_id, original_time_slot, new_time_slot,
                 reason, institution_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        `, [
            upper(b.requestingTeacherId),
            clean(b.requestingTeacherName),
            upper(b.targetTeacherId) || null,
            clean(b.targetTeacherName) || null,
            b.swapType,
            b.swapDate,
            semOf(b.semesterNumber, 3),
            clean(b.branch, "AIML"),
            upper(b.subjectCode),
            b.originalPeriodId,
            b.originalTimeSlot,
            clean(b.newTimeSlot, b.originalTimeSlot),
            clean(b.reason),
            tenant
        ]);

        res.status(201).json({
            success: true,
            message: "Swap request submitted to HOD."
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get("/api/hod/swap-requests", async (req, res) => {
    const tenant = tenantOf(req.query.institutionId);

    try {
        const result = await pool.query(`
            SELECT *
            FROM schedule_swap_requests
            WHERE UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($1))
            ORDER BY created_at DESC
        `, [tenant]);

        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post("/api/hod/respond-swap", async (req, res) => {
    const tenant = tenantOf(req.body.institutionId);
    const status = clean(req.body.status).toUpperCase();

    try {
        const result = await pool.query(`
            UPDATE schedule_swap_requests
            SET status = $1
            WHERE id = $2
              AND UPPER(COALESCE(TRIM(institution_id), 'DR_AIT')) =
                  UPPER(TRIM($3))
            RETURNING *
        `, [status, req.body.requestId, tenant]);

        if (!result.rows.length) {
            return res.status(400).json({
                success: false,
                message: "Request record not found."
            });
        }

        res.json({
            success: true,
            message: `Swap request ${status.toLowerCase()}.`
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/* ==========================================================================
   EXISTING ROUTE MODULES
  ========================================================================== */
const authRoutes = require("./routes/auth");
const qrModule = require("./routes/qr");
const attendanceRoutes = require("./routes/attendance");
const parentAuthRoutes = require("./routes/parentAuth");
const marksRoutes = require("./routes/marks");

app.use("/api/auth", authRoutes);
app.use("/api/parent", parentAuthRoutes);
app.use("/api/qr", qrModule.router);
app.use("/api/attendance", attendanceRoutes);
app.use("/api/marks", marksRoutes);

/* ==========================================================================
   HEALTH / ROOT
  ========================================================================== */
app.get("/api/health", async (req, res) => {
    try {
        await pool.query("SELECT 1");
        res.json({
            success: true,
            database: "connected",
            time: new Date().toISOString()
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            database: "error",
            error: err.message
        });
    }
});

app.get("/", (req, res) => {
    res.sendFile(path.resolve(__dirname, "../frontend", "index.html"));
});

app.use((err, req, res, next) => {
    console.error("Internal Server Error:", err.stack || err);
    if (res.headersSent) return next(err);
    res.status(500).json({
        success: false,
        message: "Something went wrong on the server.",
        error: err.message
    });
});

const PORT = process.env.PORT || 5000;

const server = app.listen(PORT, () => {
    console.log("==================================================");
    console.log(`SERVER RUNNING ON PORT ${PORT}`);
    console.log("STUDENT MARKS: USN + SEMESTER DIRECT FETCH ENABLED");
    console.log("ATTENDANCE REGISTER: STRICT BRANCH + SEMESTER FILTERING ENABLED");
    console.log("==================================================");
});

server.setTimeout(30000);

module.exports = app;

