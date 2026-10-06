const express = require('express');
const router = express.Router();
const pool = require('../db');
const crypto = require('crypto');

// ============================================================================
// SHARED HELPERS
// ============================================================================

const DEFAULT_TENANT = 'DR_AIT';
const DEFAULT_BRANCH = 'AIML';
const DEFAULT_SEMESTER = 5;

function cleanTenant(value) {
    return String(value || DEFAULT_TENANT).trim() || DEFAULT_TENANT;
}

function cleanUsn(value) {
    return String(value || '').trim().toUpperCase();
}

function cleanRole(value) {
    return String(value || 'student').trim().toLowerCase();
}

function cleanText(value) {
    return value === undefined || value === null ? '' : String(value).trim();
}

function sameRoleGroup(requestedRole, storedRole) {
    const requested = cleanRole(requestedRole);
    const stored = cleanRole(storedRole);

    if (requested === stored) return true;

    // Teacher/faculty/staff are treated as the same teacher portal group.
    if (
        ['teacher', 'faculty', 'staff'].includes(requested) &&
        ['teacher', 'faculty', 'staff'].includes(stored)
    ) {
        return true;
    }

    // HOD has its own role, but keep compatibility with existing HOD/teacher
    // login flows only where the requested role is explicitly a teacher group.
    return false;
}

function normalizeBranch(value) {
    return cleanText(value).toUpperCase() || DEFAULT_BRANCH;
}

function parseSemester(value) {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : DEFAULT_SEMESTER;
}

// ============================================================================
// 0. INITIATE LOGIN CHALLENGE & DEVICE BINDING CHECK
// ============================================================================

router.post('/login-challenge', async (req, res) => {
    const {
        usn,
        role,
        deviceFingerprint,
        institutionId
    } = req.body || {};

    const targetTenant = cleanTenant(institutionId);
    const requestedRole = cleanRole(role);
    const cleanStudentOrUserUsn = cleanUsn(usn);

    if (!cleanStudentOrUserUsn) {
        return res.status(400).json({
            success: false,
            message: 'USN / Username is required.'
        });
    }

    try {
        const result = await pool.query(
            `SELECT
                usn,
                name,
                role,
                password,
                device_fingerprint,
                biometric_enabled,
                branch,
                institution_id
             FROM users
             WHERE UPPER(TRIM(usn)) = UPPER(TRIM($1))
               AND COALESCE(institution_id, $2) ILIKE $2
               AND (
                    LOWER(TRIM(role)) = LOWER(TRIM($3))
                    OR (
                        LOWER(TRIM($3)) IN ('teacher', 'faculty', 'staff')
                        AND LOWER(TRIM(role)) IN ('teacher', 'faculty', 'staff')
                    )
               )
             LIMIT 1`,
            [cleanStudentOrUserUsn, targetTenant, requestedRole]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Account record not found.'
            });
        }

        const user = result.rows[0];
        const storedRole = cleanRole(user.role);

        if (storedRole === 'student') {
            const storedFingerprint = cleanText(user.device_fingerprint);
            const incomingFingerprint = cleanText(deviceFingerprint);

            if (
                storedFingerprint !== '' &&
                incomingFingerprint !== '' &&
                storedFingerprint !== incomingFingerprint
            ) {
                console.warn(
                    `🚨 [CHALLENGE PROXY ATTEMPT] Student USN ${user.usn} attempted challenge from unauthorized device!`
                );

                return res.status(403).json({
                    success: false,
                    message:
                        '⛔ PROXY DETECTED & ACCESS DENIED: This student account is permanently bound to another registered device. Multi-device login is strictly blocked.'
                });
            }
        }

        const challenge = crypto.randomBytes(32).toString('base64url');

        return res.json({
            success: true,
            challenge,
            biometricEnabled: Boolean(user.biometric_enabled),
            userName: user.name,
            branch: user.branch || DEFAULT_BRANCH,
            institutionId: user.institution_id || targetTenant
        });
    } catch (err) {
        console.error('💥 LOGIN CHALLENGE ERROR:', err);

        return res.status(500).json({
            success: false,
            message: 'Login challenge failed.',
            error: err.message
        });
    }
});

// ============================================================================
// 1. SECURE COMBINED LOGIN
// ============================================================================

router.post('/combined-login', async (req, res) => {
    const {
        usn,
        password,
        role,
        deviceFingerprint,
        institutionId,
        childUsn
    } = req.body || {};

    const targetTenant = cleanTenant(institutionId);
    const requestedRole = cleanRole(role);
    const cleanUserUsn = cleanUsn(usn);

    if (!cleanUserUsn || password === undefined || password === null) {
        return res.status(400).json({
            success: false,
            message: 'USN and password are required.'
        });
    }

    try {
        const result = await pool.query(
            `SELECT *
             FROM users
             WHERE UPPER(TRIM(usn)) = UPPER(TRIM($1))
               AND COALESCE(institution_id, $2) ILIKE $2
               AND (
                    LOWER(TRIM(role)) = LOWER(TRIM($3))
                    OR (
                        LOWER(TRIM($3)) IN ('teacher', 'faculty', 'staff')
                        AND LOWER(TRIM(role)) IN ('teacher', 'faculty', 'staff')
                    )
               )
             LIMIT 1`,
            [cleanUserUsn, targetTenant, requestedRole]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Account record not found.'
            });
        }

        const user = result.rows[0];

        if (user.password !== password) {
            return res.status(400).json({
                success: false,
                message: 'Incorrect credentials.'
            });
        }

        if (requestedRole === 'parent' && childUsn) {
            const storedChildUsn = cleanUsn(user.child_usn);
            const suppliedChildUsn = cleanUsn(childUsn);

            if (storedChildUsn && storedChildUsn !== suppliedChildUsn) {
                return res.status(400).json({
                    success: false,
                    message:
                        '⚠️ Incorrect student USN. This USN does not match your registered ward.'
                });
            }
        }

        if (cleanRole(user.role) === 'student') {
            const storedFingerprint = cleanText(user.device_fingerprint);
            const incomingFingerprint = cleanText(deviceFingerprint);

            if (storedFingerprint === '') {
                if (incomingFingerprint !== '') {
                    await pool.query(
                        `UPDATE users
                         SET device_fingerprint = $1
                         WHERE UPPER(TRIM(usn)) = UPPER(TRIM($2))
                           AND COALESCE(institution_id, $3) ILIKE $3`,
                        [incomingFingerprint, user.usn, targetTenant]
                    );
                }
            } else if (storedFingerprint !== incomingFingerprint) {
                console.warn(
                    `🚨 [COMBINED LOGIN PROXY ATTEMPT] Student USN ${user.usn} attempted login from an unauthorized device!`
                );

                return res.status(403).json({
                    success: false,
                    message:
                        '⛔ PROXY DETECTED & ACCESS DENIED: This student account is permanently bound to a different registered device. Multi-device login is strictly blocked.'
                });
            }
        }

        console.log(
            `👤 [USER LOGIN SUCCESS] Role: ${String(user.role || '').toUpperCase()} | Name: ${user.name} | USN: ${user.usn}`
        );

        return res.json({
            success: true,
            usn: user.usn,
            name: user.name,
            role: user.role,
            subjectName: user.subject_name,
            branch: user.branch || DEFAULT_BRANCH,
            institutionId: user.institution_id || targetTenant,
            childUsn: user.child_usn || null
        });
    } catch (err) {
        console.error('💥 COMBINED LOGIN ERROR:', err);

        return res.status(500).json({
            success: false,
            message: 'Login failed.',
            error: err.message
        });
    }
});

// ============================================================================
// 2. SIGNUP WORKSPACE REGISTRY
// ============================================================================

router.post('/signup', async (req, res) => {
    const {
        usn,
        email,
        password,
        role,
        name,
        childUsn,
        subjectName,
        branch,
        institutionId,
        phoneNumber,
        deviceFingerprint
    } = req.body || {};

    const tenant = cleanTenant(institutionId);
    const cleanRoleValue = cleanRole(role);
    const isStudent = cleanRoleValue === 'student';
    const cleanSignupUsn = cleanUsn(usn);
    const cleanBranch = normalizeBranch(branch);

    if (!cleanSignupUsn || !password) {
        return res.status(400).json({
            success: false,
            message: 'USN / Username and password are required.'
        });
    }

    try {
        const userExists = await pool.query(
            `SELECT 1
             FROM users
             WHERE UPPER(TRIM(usn)) = UPPER(TRIM($1))
               AND COALESCE(institution_id, $2) ILIKE $2
             LIMIT 1`,
            [cleanSignupUsn, tenant]
        );

        if (userExists.rows.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'USN / Username already registered.'
            });
        }

        await pool.query(
            `INSERT INTO users (
                usn,
                email,
                password,
                role,
                name,
                child_usn,
                subject_name,
                branch,
                institution_id,
                phone_number,
                device_fingerprint,
                biometric_enabled
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
                cleanSignupUsn,
                cleanText(email) || `${cleanSignupUsn}@drait.edu.in`,
                password,
                cleanRoleValue,
                cleanText(name) || cleanSignupUsn,
                childUsn ? cleanUsn(childUsn) : null,
                ['teacher', 'faculty', 'staff', 'hod'].includes(cleanRoleValue)
                    ? cleanText(subjectName) || null
                    : null,
                cleanBranch,
                tenant,
                cleanText(phoneNumber) || '+919876543210',
                deviceFingerprint ? cleanText(deviceFingerprint) : null,
                isStudent
            ]
        );

        return res.status(201).json({
            success: true,
            message: 'Account and device bound successfully!'
        });
    } catch (err) {
        console.error('💥 SIGNUP ERROR:', err);

        return res.status(500).json({
            success: false,
            message: 'Signup failed.',
            error: err.message
        });
    }
});

// ============================================================================
// 3. TEACHER REGISTER A NEW CLASS SESSION INSTANCE
// ============================================================================

router.post('/create-session', async (req, res) => {
    const {
        sessionCode,
        subjectName,
        subjectCode,
        institutionId
    } = req.body || {};

    const tenant = cleanTenant(institutionId);
    const cleanSessionCode = cleanText(sessionCode);
    const cleanSubjectName = cleanText(subjectName) || 'AI';
    const cleanSubjectCode = cleanText(subjectCode) || cleanSubjectName;

    if (!cleanSessionCode) {
        return res.status(400).json({
            success: false,
            message: 'Session code is required.'
        });
    }

    try {
        // Do not create duplicate class-session rows for the same session.
        const existing = await pool.query(
            `SELECT session_code, subject_name, subject_code, created_at
             FROM class_sessions
             WHERE session_code = $1
               AND COALESCE(institution_id, $2) ILIKE $2
             LIMIT 1`,
            [cleanSessionCode, tenant]
        );

        if (existing.rows.length > 0) {
            return res.status(200).json({
                success: true,
                alreadyExists: true,
                session: existing.rows[0]
            });
        }

        const inserted = await pool.query(
            `INSERT INTO class_sessions (
                session_code,
                subject_name,
                subject_code,
                institution_id,
                created_at
             )
             VALUES ($1, $2, $3, $4, NOW())
             RETURNING session_code, subject_name, subject_code, institution_id, created_at`,
            [
                cleanSessionCode,
                cleanSubjectName,
                cleanSubjectCode,
                tenant
            ]
        );

        return res.status(200).json({
            success: true,
            session: inserted.rows[0]
        });
    } catch (err) {
        console.error('💥 CREATE SESSION ERROR:', err);

        return res.status(500).json({
            success: false,
            message: 'Unable to create class session.',
            error: err.message
        });
    }
});

// ============================================================================
// 4. SUBMIT ATTENDANCE WITH GEOFENCING
// ============================================================================

router.post('/submit-attendance', async (req, res) => {
    const {
        studentId,
        subjectName,
        sessionCode,
        latitude,
        longitude,
        distance,
        institutionId
    } = req.body || {};

    const tenant = cleanTenant(institutionId);
    const cleanStudentId = cleanUsn(studentId);
    const cleanSessionCode = cleanText(sessionCode);
    const cleanSubjectName = cleanText(subjectName) || 'AI';

    if (!cleanStudentId || !cleanSessionCode) {
        return res.status(400).json({
            success: false,
            message: 'Student ID and session code are required.'
        });
    }

    try {
        let roundedDistance = 0;

        // Manual teacher/HOD override bypasses GPS validation.
        if (distance === '0.00_MANUAL') {
            roundedDistance = 0;
        } else {
            if (
                latitude === undefined ||
                longitude === undefined ||
                latitude === null ||
                longitude === null ||
                latitude === '' ||
                longitude === ''
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        '❌ Location Required: You must turn on your device location services to scan and record attendance.'
                });
            }

            const studentLat = Number.parseFloat(latitude);
            const studentLon = Number.parseFloat(longitude);

            if (!Number.isFinite(studentLat) || !Number.isFinite(studentLon)) {
                return res.status(400).json({
                    success: false,
                    message:
                        '❌ Invalid Location Data: Unable to read valid GPS coordinates from your device.'
                });
            }

            const COLLEGE_LAT = 12.9635;
            const COLLEGE_LON = 77.5059;
            const MAX_ALLOWED_RADIUS_METERS = 300;

            function calculateDistance(lat1, lon1, lat2, lon2) {
                const R = 6371e3;
                const phi1 = lat1 * Math.PI / 180;
                const phi2 = lat2 * Math.PI / 180;
                const deltaPhi = (lat2 - lat1) * Math.PI / 180;
                const deltaLambda = (lon2 - lon1) * Math.PI / 180;

                const a =
                    Math.sin(deltaPhi / 2) ** 2 +
                    Math.cos(phi1) *
                    Math.cos(phi2) *
                    Math.sin(deltaLambda / 2) ** 2;

                const c =
                    2 *
                    Math.atan2(
                        Math.sqrt(a),
                        Math.sqrt(1 - a)
                    );

                return R * c;
            }

            const distanceMeters = calculateDistance(
                studentLat,
                studentLon,
                COLLEGE_LAT,
                COLLEGE_LON
            );

            roundedDistance = Math.round(distanceMeters);

            if (distanceMeters > MAX_ALLOWED_RADIUS_METERS) {
                return res.status(403).json({
                    success: false,
                    message:
                        `⛔ ACCESS DENIED: You are outside the Dr. AIT campus region. ` +
                        `Your current distance from college is ${roundedDistance} meters ` +
                        `(Allowed limit: ${MAX_ALLOWED_RADIUS_METERS}m). Please move inside the campus to scan.`
                });
            }
        }

        // IMPORTANT:
        // Verify the session exists before writing attendance. This prevents
        // attendance from being attached to a missing/incorrect session.
        let sessionResult = await pool.query(
            `SELECT
                session_code,
                subject_name,
                subject_code,
                institution_id,
                created_at
             FROM class_sessions
             WHERE session_code = $1
               AND COALESCE(institution_id, $2) ILIKE $2
             LIMIT 1`,
            [cleanSessionCode, tenant]
        );

        if (sessionResult.rows.length === 0) {
            // Preserve the existing fallback used by the application.
            await pool.query(
                `INSERT INTO class_sessions (
                    session_code,
                    subject_name,
                    subject_code,
                    institution_id,
                    created_at
                 )
                 VALUES ($1, $2, $3, $4, NOW())
                 ON CONFLICT DO NOTHING`,
                [
                    cleanSessionCode,
                    cleanSubjectName,
                    cleanSubjectName,
                    tenant
                ]
            );

            sessionResult = await pool.query(
                `SELECT
                    session_code,
                    subject_name,
                    subject_code,
                    institution_id,
                    created_at
                 FROM class_sessions
                 WHERE session_code = $1
                   AND COALESCE(institution_id, $2) ILIKE $2
                 LIMIT 1`,
                [cleanSessionCode, tenant]
            );
        }

        if (sessionResult.rows.length === 0) {
            return res.status(500).json({
                success: false,
                message:
                    'Attendance session could not be created or found. Please ask the faculty to regenerate the QR code.'
            });
        }

        const session = sessionResult.rows[0];

        const studentLookup = await pool.query(
            `SELECT usn, name, branch, semester_number
             FROM users
             WHERE UPPER(TRIM(usn)) = UPPER(TRIM($1))
               AND COALESCE(institution_id, $2) ILIKE $2
             LIMIT 1`,
            [cleanStudentId, tenant]
        );

        if (studentLookup.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Student account was not found for this institution.'
            });
        }

        const student = studentLookup.rows[0];
        const studentFullName = student.name || 'Student';

        console.log(
            `📱 [ATTENDANCE SCAN] Student USN: ${student.usn} (${studentFullName}) | ` +
            `Subject: ${session.subject_name || cleanSubjectName} | ` +
            `Session: ${session.session_code} | Distance: ${roundedDistance}m`
        );

        // Keep the existing attendance uniqueness model.
        // If a student scans the same QR twice, return success instead of
        // showing a false network/server error.
        try {
            const attendanceInsert = await pool.query(
                `INSERT INTO users_attendance (
                    student_id,
                    student_full_name,
                    subject_name,
                    session_code,
                    distance,
                    latitude,
                    longitude,
                    institution_id,
                    created_at
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
                 ON CONFLICT (student_id, session_code) DO NOTHING
                 RETURNING id`,
                [
                    cleanStudentId,
                    studentFullName,
                    session.subject_name || cleanSubjectName,
                    cleanSessionCode,
                    `${roundedDistance}m`,
                    latitude === '' || latitude === undefined ? null : latitude,
                    longitude === '' || longitude === undefined ? null : longitude,
                    tenant
                ]
            );

            if (attendanceInsert.rows.length === 0) {
                return res.status(200).json({
                    success: true,
                    alreadyMarked: true,
                    message: 'Attendance already marked for this session.'
                });
            }
        } catch (dbErr) {
            console.error('💥 ATTENDANCE INSERT ERROR:', dbErr);

            if (dbErr.code === '23505') {
                return res.status(200).json({
                    success: true,
                    alreadyMarked: true,
                    message: 'Attendance already marked for this session.'
                });
            }

            throw dbErr;
        }

        return res.status(200).json({
            success: true,
            message: '✅ Attendance successfully recorded!',
            distance: `${roundedDistance}m`,
            sessionCode: cleanSessionCode
        });
    } catch (err) {
        console.error('💥 SUBMIT ATTENDANCE ERROR:', err);

        return res.status(500).json({
            success: false,
            message: 'Unable to record attendance.',
            error: err.message
        });
    }
});

// ============================================================================
// 5. END SESSION
// ============================================================================

router.post('/end-session', async (req, res) => {
    const {
        sessionCode,
        subjectName,
        institutionId
    } = req.body || {};

    const tenant = cleanTenant(institutionId);
    const cleanSessionCode = cleanText(sessionCode);
    const targetSubject = cleanText(subjectName) || 'AI';

    if (!cleanSessionCode) {
        return res.status(400).json({
            success: false,
            message: 'Session code is required.'
        });
    }

    try {
        const allStudents = await pool.query(
            `SELECT usn, name, phone_number
             FROM users
             WHERE LOWER(TRIM(role)) = 'student'
               AND COALESCE(institution_id, $1) ILIKE $1`,
            [tenant]
        );

        const presentStudents = await pool.query(
            `SELECT student_id
             FROM users_attendance
             WHERE session_code = $1
               AND COALESCE(institution_id, $2) ILIKE $2`,
            [cleanSessionCode, tenant]
        );

        const presentUsns = new Set(
            presentStudents.rows
                .map(row => cleanUsn(row.student_id))
                .filter(Boolean)
        );

        let absentCount = 0;

        for (const student of allStudents.rows) {
            if (!presentUsns.has(cleanUsn(student.usn))) {
                absentCount++;
            }
        }

        console.log(
            `📱 [SESSION CLOSED] Session: ${cleanSessionCode} | ` +
            `Subject: ${targetSubject} | Total Absentees Flagged: ${absentCount}`
        );

        return res.json({
            success: true,
            absentCount
        });
    } catch (err) {
        console.error('💥 END SESSION ERROR:', err);

        return res.status(500).json({
            success: false,
            message: 'Unable to close session.',
            error: err.message
        });
    }
});

// ============================================================================
// 6. STREAM ATTENDANCE RECORDS
// ============================================================================

router.get('/attendance-records', async (req, res) => {
    const {
        sessionCode,
        institutionId
    } = req.query || {};

    const tenant = cleanTenant(institutionId);

    try {
        let queryStr = `
            SELECT
                a.id,
                a.student_id,
                a.session_code,
                a.distance,
                a.created_at,
                a.subject_name,
                COALESCE(
                    a.student_full_name,
                    u.name,
                    'Verified Student'
                ) AS student_full_name
            FROM users_attendance a
            LEFT JOIN users u
                ON UPPER(TRIM(a.student_id)) = UPPER(TRIM(u.usn))
               AND COALESCE(u.institution_id, $1) ILIKE $1
            WHERE COALESCE(a.institution_id, $1) ILIKE $1
        `;

        const params = [tenant];

        if (sessionCode) {
            queryStr += ` AND a.session_code = $2 `;
            params.push(cleanText(sessionCode));
        }

        queryStr += ` ORDER BY a.created_at DESC`;

        const result = await pool.query(queryStr, params);

        const processedRows = result.rows.map(row => {
            const rawDistance =
                row.distance !== null && row.distance !== undefined
                    ? String(row.distance)
                    : '0m';

            const hasProxyFlag = rawDistance.includes('_PROXY');
            const displayDistance = hasProxyFlag
                ? `${rawDistance.split('_')[0]}m`
                : rawDistance.endsWith('m')
                    ? rawDistance
                    : `${rawDistance}m`;

            return {
                ...row,
                distance: displayDistance,
                is_proxy: hasProxyFlag
            };
        });

        return res.json(processedRows);
    } catch (err) {
        console.error('💥 ATTENDANCE RECORDS ERROR:', err);

        return res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

// ============================================================================
// 6.1 TEACHER REAL-TIME CLASS ATTENDANCE ROSTER
// ============================================================================

router.get('/teacher-session-roster', async (req, res) => {
    const {
        sessionCode,
        institutionId
    } = req.query || {};

    const tenant = cleanTenant(institutionId);
    const cleanSessionCode = cleanText(sessionCode);

    if (!cleanSessionCode) {
        return res.status(400).json({
            success: false,
            message: 'Session code is required.'
        });
    }

    try {
        const slotInfoQuery = await pool.query(
            `SELECT
                t.branch,
                t.semester_number,
                t.subject_code
             FROM class_sessions cs
             LEFT JOIN weekly_timetables t
               ON (
                    UPPER(TRIM(cs.subject_code)) = UPPER(TRIM(t.subject_code))
                    OR UPPER(TRIM(cs.subject_name)) = UPPER(TRIM(t.subject_name))
                    OR UPPER(TRIM(cs.subject_name)) = UPPER(TRIM(t.subject_code))
               )
              AND COALESCE(cs.institution_id, $2) ILIKE $2
              AND COALESCE(t.institution_id, $2) ILIKE $2
             WHERE cs.session_code = $1
               AND COALESCE(cs.institution_id, $2) ILIKE $2
             LIMIT 1`,
            [cleanSessionCode, tenant]
        );

        let targetBranch = DEFAULT_BRANCH;
        let targetSemester = DEFAULT_SEMESTER;

        if (slotInfoQuery.rows.length > 0) {
            targetBranch =
                normalizeBranch(slotInfoQuery.rows[0].branch) ||
                DEFAULT_BRANCH;

            targetSemester =
                parseSemester(slotInfoQuery.rows[0].semester_number);
        }

        const allStudentsResult = await pool.query(
            `SELECT
                usn,
                name,
                phone_number,
                branch,
                semester_number
             FROM users
             WHERE LOWER(TRIM(role)) = 'student'
               AND COALESCE(institution_id, $1) ILIKE $1
               AND UPPER(TRIM(COALESCE(branch, ''))) = UPPER(TRIM($2))
               AND COALESCE(semester_number, $3) = $3
             ORDER BY usn ASC`,
            [tenant, targetBranch, targetSemester]
        );

        const presentResult = await pool.query(
            `SELECT
                a.student_id,
                a.student_full_name,
                a.distance,
                a.created_at,
                a.latitude,
                a.longitude
             FROM users_attendance a
             WHERE a.session_code = $1
               AND COALESCE(a.institution_id, $2) ILIKE $2`,
            [cleanSessionCode, tenant]
        );

        const presentMap = new Map();

        presentResult.rows.forEach(row => {
            presentMap.set(cleanUsn(row.student_id), row);
        });

        const presentList = [];
        const absentList = [];

        allStudentsResult.rows.forEach(student => {
            const studentUsn = cleanUsn(student.usn);

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
            sessionCode: cleanSessionCode,
            branch: targetBranch,
            semester: targetSemester,
            totalStudents: allStudentsResult.rows.length,
            presentCount: presentList.length,
            absentCount: absentList.length,
            presentStudents: presentList,
            absentStudents: absentList
        });
    } catch (err) {
        console.error('💥 TEACHER ROSTER ERROR:', err);

        return res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

// ============================================================================
// 6.2 FETCH STUDENT ROSTER FOR TEACHER MARKS ENTRY
// ============================================================================

router.get('/teacher-student-roster', async (req, res) => {
    const {
        branch,
        semesterNumber,
        institutionId
    } = req.query || {};

    const tenant = cleanTenant(institutionId);
    const targetBranch = normalizeBranch(branch);
    const targetSemester = parseSemester(semesterNumber);

    try {
        const result = await pool.query(
            `SELECT
                usn,
                name,
                branch,
                semester_number
             FROM users
             WHERE LOWER(TRIM(role)) = 'student'
               AND COALESCE(institution_id, $1) ILIKE $1
               AND UPPER(TRIM(COALESCE(branch, ''))) = UPPER(TRIM($2))
               AND COALESCE(semester_number, $3) = $3
             ORDER BY usn ASC`,
            [tenant, targetBranch, targetSemester]
        );

        return res.json({
            success: true,
            students: result.rows
        });
    } catch (err) {
        console.error('💥 TEACHER STUDENT ROSTER ERROR:', err);

        return res.status(500).json({
            success: false,
            students: [],
            error: err.message
        });
    }
});

// ============================================================================
// 6.3 HOD MANUAL ATTENDANCE OVERRIDE
// ============================================================================

router.post('/hod/override-attendance', async (req, res) => {
    const {
        studentUsn,
        sessionCode,
        subjectName,
        institutionId
    } = req.body || {};

    const tenant = cleanTenant(institutionId);
    const cleanStudentUsn = cleanUsn(studentUsn);
    const cleanSessionCode = cleanText(sessionCode);

    if (!cleanStudentUsn || !cleanSessionCode) {
        return res.status(400).json({
            success: false,
            message: 'Student USN and Session Code are required.'
        });
    }

    try {
        const studentLookup = await pool.query(
            `SELECT name
             FROM users
             WHERE UPPER(TRIM(usn)) = UPPER(TRIM($1))
               AND COALESCE(institution_id, $2) ILIKE $2
             LIMIT 1`,
            [cleanStudentUsn, tenant]
        );

        if (studentLookup.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Student record not found.'
            });
        }

        const studentFullName = studentLookup.rows[0].name || 'Student';

        const duplicateCheck = await pool.query(
            `SELECT 1
             FROM users_attendance
             WHERE UPPER(TRIM(student_id)) = UPPER(TRIM($1))
               AND session_code = $2
               AND COALESCE(institution_id, $3) ILIKE $3
             LIMIT 1`,
            [cleanStudentUsn, cleanSessionCode, tenant]
        );

        if (duplicateCheck.rows.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Student is already marked present for this session.'
            });
        }

        await pool.query(
            `INSERT INTO users_attendance (
                student_id,
                student_full_name,
                subject_name,
                session_code,
                distance,
                institution_id,
                created_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [
                cleanStudentUsn,
                studentFullName,
                cleanText(subjectName) || 'AI',
                cleanSessionCode,
                'HOD_EXCUSED',
                tenant
            ]
        );

        return res.json({
            success: true,
            message: `Successfully excused and marked ${cleanStudentUsn} present!`
        });
    } catch (err) {
        console.error('💥 HOD ATTENDANCE OVERRIDE ERROR:', err);

        return res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

// ============================================================================
// 6.4 FETCH STUDENT MARKS OVERVIEW
// ============================================================================

router.get('/teacher/student-marks-overview', async (req, res) => {
    const {
        studentUsn,
        semester,
        teacherId,
        institutionId
    } = req.query || {};

    const tenant = cleanTenant(institutionId);
    const cleanUsnValue = cleanUsn(studentUsn);
    const cleanTeacherId = cleanText(teacherId);
    const semNumber = parseSemester(semester);

    try {
        const studentRes = await pool.query(
            `SELECT
                usn,
                name,
                branch,
                semester_number
             FROM users
             WHERE UPPER(TRIM(usn)) = UPPER(TRIM($1))
               AND COALESCE(institution_id, $2) ILIKE $2
             LIMIT 1`,
            [cleanUsnValue, tenant]
        );

        if (studentRes.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Student record not found.'
            });
        }

        const student = studentRes.rows[0];

        const teacherSubjectsRes = await pool.query(
            `SELECT DISTINCT
                UPPER(TRIM(subject_code)) AS subject_code,
                COALESCE(NULLIF(TRIM(subject_name), ''), TRIM(subject_code)) AS subject_name
             FROM weekly_timetables
             WHERE (
                    LOWER(TRIM(assigned_teacher_id)) = LOWER(TRIM($1))
                    OR LOWER(TRIM(assigned_teacher_name)) ILIKE LOWER(TRIM($1))
             )
               AND COALESCE(institution_id, $2) ILIKE $2
               AND subject_code IS NOT NULL
               AND TRIM(subject_code) <> ''
             ORDER BY UPPER(TRIM(subject_code))`,
            [cleanTeacherId, tenant]
        );

        const allowedSubjects = teacherSubjectsRes.rows;

        if (allowedSubjects.length === 0) {
            return res.status(403).json({
                success: false,
                message:
                    'You have no HOD-assigned subjects mapped in the timetable to evaluate.'
            });
        }

        const allowedCodes = allowedSubjects.map(
            subject => subject.subject_code
        );

        const marksRes = await pool.query(
            `SELECT
                subject_code,
                subject_name,
                cie1,
                cie2,
                cie3,
                see
             FROM student_marks
             WHERE UPPER(TRIM(usn)) = UPPER(TRIM($1))
               AND COALESCE(institution_id, $2) ILIKE $2
               AND UPPER(TRIM(COALESCE(subject_code, subject))) = ANY($3::text[])`,
            [cleanUsnValue, tenant, allowedCodes]
        );

        const marksMap = new Map();

        marksRes.rows.forEach(mark => {
            const key = cleanText(
                mark.subject_code || mark.subject_name
            ).toUpperCase();

            marksMap.set(key, mark);
        });

        const subjectsPayload = allowedSubjects.map(subject => {
            const code = subject.subject_code;
            const existing =
                marksMap.get(code.toUpperCase()) || {};

            return {
                subject_code: code,
                subject_name: subject.subject_name || code,
                cie1: existing.cie1 ?? 0,
                cie2: existing.cie2 ?? 0,
                cie3: existing.cie3 ?? 0,
                see: existing.see ?? 0
            };
        });

        return res.json({
            success: true,
            student,
            subjects: subjectsPayload
        });
    } catch (err) {
        console.error('💥 STUDENT MARKS OVERVIEW ERROR:', err);

        return res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

// ============================================================================
// 6.5 TEACHER: EXPORT COMPLETE MASTER ATTENDANCE REGISTER PDF
// ============================================================================

router.get('/teacher/export-attendance-pdf', async (req, res) => {
    const {
        branch,
        semesterNumber,
        institutionId
    } = req.query || {};

    const tenant = cleanTenant(institutionId);
    const targetBranch = normalizeBranch(branch);
    const targetSemester = parseSemester(semesterNumber);

    try {
        const studentsRes = await pool.query(
            `SELECT usn, name
             FROM users
             WHERE LOWER(TRIM(role)) = 'student'
               AND COALESCE(institution_id, $1) ILIKE $1
               AND UPPER(TRIM(COALESCE(branch, ''))) = UPPER(TRIM($2))
               AND COALESCE(semester_number, $3) = $3
             ORDER BY usn ASC`,
            [tenant, targetBranch, targetSemester]
        );

        const sessionsRes = await pool.query(
            `SELECT
                session_code,
                subject_name,
                subject_code,
                created_at
             FROM class_sessions
             WHERE COALESCE(institution_id, $1) ILIKE $1
             ORDER BY created_at ASC`,
            [tenant]
        );

        const attendanceRes = await pool.query(
            `SELECT student_id, session_code
             FROM users_attendance
             WHERE COALESCE(institution_id, $1) ILIKE $1`,
            [tenant]
        );

        const attendanceMap = new Set();

        attendanceRes.rows.forEach(row => {
            attendanceMap.add(
                `${cleanUsn(row.student_id)}_${row.session_code}`
            );
        });

        return res.json({
            success: true,
            students: studentsRes.rows,
            sessions: sessionsRes.rows,
            attendanceRecords: Array.from(attendanceMap)
        });
    } catch (err) {
        console.error('💥 PDF EXPORT ERROR:', err);

        return res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

// ============================================================================
// 7. STUDENT SUBJECT METRICS
// ============================================================================

router.get('/student-subject-metrics', async (req, res) => {
    const {
        studentId,
        semester,
        institutionId
    } = req.query || {};

    const tenant = cleanTenant(institutionId);
    const cleanStudentId = cleanUsn(studentId);
    const semNumber = parseSemester(semester);

    if (!cleanStudentId) {
        return res.status(400).json({
            success: false,
            error: 'Student ID (USN) is required.'
        });
    }

    try {
        const totalConducted = await pool.query(
            `SELECT subject_name, COUNT(*) AS conducted
             FROM class_sessions
             WHERE COALESCE(institution_id, $1) ILIKE $1
             GROUP BY subject_name`,
            [tenant]
        );

        const totalAttended = await pool.query(
            `SELECT subject_name, COUNT(*) AS attended
             FROM users_attendance
             WHERE UPPER(TRIM(student_id)) = UPPER(TRIM($1))
               AND COALESCE(institution_id, $2) ILIKE $2
             GROUP BY subject_name`,
            [cleanStudentId, tenant]
        );

        const logsHistory = await pool.query(
            `SELECT subject_name, created_at
             FROM users_attendance
             WHERE UPPER(TRIM(student_id)) = UPPER(TRIM($1))
               AND COALESCE(institution_id, $2) ILIKE $2
             ORDER BY created_at DESC`,
            [cleanStudentId, tenant]
        );

        const realMarksResult = await pool.query(
            `SELECT *
             FROM student_marks
             WHERE UPPER(TRIM(usn)) = UPPER(TRIM($1))
               AND semester_number = $2
               AND COALESCE(institution_id, $3) ILIKE $3`,
            [cleanStudentId, semNumber, tenant]
        );

        const semSummaryResult = await pool.query(
            `SELECT sgpa, cgpa
             FROM student_semesters
             WHERE UPPER(TRIM(usn)) = UPPER(TRIM($1))
               AND semester_number = $2
               AND COALESCE(institution_id, $3) ILIKE $3`,
            [cleanStudentId, semNumber, tenant]
        );

        const summaryRow =
            semSummaryResult.rows[0] || {
                sgpa: null,
                cgpa: null
            };

        const aiPredictions = [];

        realMarksResult.rows.forEach(markRow => {
            const targetSubject = cleanText(
                markRow.subject_name || markRow.subject_code
            ).toUpperCase();

            const condObj =
                totalConducted.rows.find(
                    row =>
                        cleanText(row.subject_name).toUpperCase() ===
                        targetSubject
                ) || { conducted: 0 };

            const attObj =
                totalAttended.rows.find(
                    row =>
                        cleanText(row.subject_name).toUpperCase() ===
                        targetSubject
                ) || { attended: 0 };

            const conductedCount =
                parseInt(condObj.conducted, 10) || 0;

            const attendedCount =
                parseInt(attObj.attended, 10) || 0;

            const absentCount =
                Math.max(0, conductedCount - attendedCount);

            const currentRatio =
                conductedCount > 0
                    ? attendedCount / conductedCount
                    : 1.0;

            let predictedFinalRatio =
                Math.round(currentRatio * 100);

            if (
                conductedCount > 1 &&
                attendedCount < conductedCount
            ) {
                predictedFinalRatio = Math.max(
                    45,
                    predictedFinalRatio - 5
                );
            }

            const isShortage =
                conductedCount > 0 &&
                predictedFinalRatio < 75;

            aiPredictions.push({
                subject: markRow.subject_name,
                subject_code: markRow.subject_code,
                semester_number: markRow.semester_number,
                conducted: conductedCount,
                attended: attendedCount,
                absent: absentCount,
                estimated_final:
                    conductedCount > 0
                        ? `${predictedFinalRatio}%`
                        : '100%',
                risk_status: isShortage
                    ? '⚠️ HIGH RISK SHORTAGE'
                    : '✅ SAFE ZONE',
                cie1: markRow.cie1,
                cie2: markRow.cie2,
                cie3: markRow.cie3,
                see: markRow.see
            });
        });

        return res.json({
            success: true,
            conducted: totalConducted.rows,
            attended: totalAttended.rows,
            history: logsHistory.rows,
            ai_predictions: aiPredictions,
            sgpa: summaryRow.sgpa,
            cgpa: summaryRow.cgpa
        });
    } catch (err) {
        console.error('💥 METRICS ERROR:', err);

        return res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

// ============================================================================
// 8. DISTINCT HISTORICAL SESSIONS
// ============================================================================

router.get('/distinct-sessions', async (req, res) => {
    const {
        subject,
        institutionId
    } = req.query || {};

    const tenant = cleanTenant(institutionId);
    const cleanSubject = cleanText(subject);

    try {
        let queryStr = `
            SELECT
                session_code,
                created_at,
                subject_name,
                subject_code
            FROM class_sessions
            WHERE COALESCE(institution_id, $1) ILIKE $1
        `;

        const params = [tenant];

        if (
            cleanSubject &&
            cleanSubject.toLowerCase() !== 'all' &&
            cleanSubject.toLowerCase() !== 'ml'
        ) {
            queryStr += ` AND (
                UPPER(TRIM(subject_name)) ILIKE UPPER($2)
                OR UPPER(TRIM(subject_code)) ILIKE UPPER($2)
            ) `;

            params.push(`%${cleanSubject}%`);
        }

        queryStr += ` ORDER BY created_at DESC LIMIT 50`;

        const result = await pool.query(queryStr, params);

        return res.json(result.rows);
    } catch (err) {
        console.error('💥 DISTINCT SESSIONS ERROR:', err);

        return res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

// ============================================================================
// 9. STUDENT MARKS GENERAL ROSTER
// ============================================================================

router.get('/student-marks-roster', async (req, res, next) => {
    const tenant = cleanTenant(req.query?.institutionId);

    try {
        const result = await pool.query(
            `SELECT
                u.name,
                m.usn,
                u.phone_number,
                m.subject_code,
                m.subject_name,
                m.cie1,
                m.cie2,
                m.cie3,
                m.see
             FROM student_marks m
             JOIN users u
               ON UPPER(TRIM(m.usn)) = UPPER(TRIM(u.usn))
              AND COALESCE(u.institution_id, $1) ILIKE $1
             WHERE COALESCE(m.institution_id, $1) ILIKE $1
             ORDER BY u.name ASC, m.subject_code ASC`,
            [tenant]
        );

        return res.json(result.rows);
    } catch (err) {
        console.error('💥 MARKS ROSTER ERROR:', err);
        return next(err);
    }
});

// ============================================================================
// 10. FETCH HOD-MAPPED CLASS SLOTS FOR TEACHER
// ============================================================================

router.get('/teacher-mapped-slots', async (req, res) => {
    const {
        teacherId,
        institutionId
    } = req.query || {};

    const tenant = cleanTenant(institutionId);
    const cleanId = cleanText(teacherId);

    if (!cleanId) {
        return res.status(400).json({
            success: false,
            message: 'Teacher ID is required.'
        });
    }

    try {
        const result = await pool.query(
            `SELECT *
             FROM weekly_timetables
             WHERE (
                    LOWER(TRIM(assigned_teacher_id)) = LOWER(TRIM($1))
                    OR LOWER(TRIM(assigned_teacher_name)) ILIKE LOWER(TRIM($1))
             )
               AND COALESCE(institution_id, $2) ILIKE $2
             ORDER BY id DESC`,
            [cleanId, tenant]
        );

        return res.json({
            success: true,
            slots: result.rows
        });
    } catch (err) {
        console.error('💥 TEACHER MAPPED SLOTS ERROR:', err);

        return res.status(500).json({
            success: false,
            slots: [],
            error: err.message
        });
    }
});

// ============================================================================
// 11. FORGOT PASSWORD
// ============================================================================

router.post('/forgot-password-request', async (req, res) => {
    const {
        usn,
        institutionId
    } = req.body || {};

    const tenant = cleanTenant(institutionId);
    const cleanForgotUsn = cleanUsn(usn);

    if (!cleanForgotUsn) {
        return res.status(400).json({
            success: false,
            message: 'USN / Username is required.'
        });
    }

    try {
        const userRes = await pool.query(
            `SELECT usn, name
             FROM users
             WHERE UPPER(TRIM(usn)) = UPPER(TRIM($1))
               AND COALESCE(institution_id, $2) ILIKE $2
             LIMIT 1`,
            [cleanForgotUsn, tenant]
        );

        if (userRes.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No account found with this USN.'
            });
        }

        const user = userRes.rows[0];

        // Kept compatible with the existing application flow.
        const recoveryOtp =
            Math.floor(100000 + Math.random() * 900000).toString();

        await pool.query(
            `UPDATE users
             SET device_fingerprint = NULL
             WHERE UPPER(TRIM(usn)) = UPPER(TRIM($1))
               AND COALESCE(institution_id, $2) ILIKE $2`,
            [cleanForgotUsn, tenant]
        );

        console.log(
            `🔐 [PASSWORD RESET REQUEST] -> USN: ${user.usn} | Name: ${user.name} | Recovery OTP: ${recoveryOtp}`
        );

        return res.json({
            success: true,
            message:
                'Recovery code generated successfully. Check server console for your verification code.'
        });
    } catch (err) {
        console.error('💥 FORGOT PASSWORD ERROR:', err);

        return res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

router.post('/reset-password-confirm', async (req, res) => {
    const {
        usn,
        newPassword,
        institutionId
    } = req.body || {};

    const tenant = cleanTenant(institutionId);
    const cleanResetUsn = cleanUsn(usn);

    if (!cleanResetUsn) {
        return res.status(400).json({
            success: false,
            message: 'USN / Username is required.'
        });
    }

    try {
        if (!newPassword || newPassword.length < 4) {
            return res.status(400).json({
                success: false,
                message: 'Password must be at least 4 characters long.'
            });
        }

        const updateRes = await pool.query(
            `UPDATE users
             SET password = $1
             WHERE UPPER(TRIM(usn)) = UPPER(TRIM($2))
               AND COALESCE(institution_id, $3) ILIKE $3
             RETURNING usn`,
            [newPassword, cleanResetUsn, tenant]
        );

        if (updateRes.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'User account not found.'
            });
        }

        console.log(
            `✅ [PASSWORD UPDATED] -> USN: ${cleanResetUsn} successfully reset their password.`
        );

        return res.json({
            success: true,
            message:
                'Password successfully updated! You can now log in with your new credentials.'
        });
    } catch (err) {
        console.error('💥 RESET CONFIRM ERROR:', err);

        return res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

// ============================================================================
// EXPORT ROUTER
// ============================================================================

module.exports = router;
