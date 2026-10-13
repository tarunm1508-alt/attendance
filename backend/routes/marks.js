const express = require("express");
const router = express.Router();
const pool = require("../db");

const DEFAULT_INSTITUTION = "DR_AIT";

function getTenant(value) {
    return typeof value === "string" && value.trim()
        ? value.trim()
        : DEFAULT_INSTITUTION;
}

function normalizeUsn(value) {
    return typeof value === "string" ? value.trim().toUpperCase() : "";
}

/**
 * 1. GET STUDENT PROFILE, MARKS, AND LINKED PARENT
 * Reads section and academic_year from the existing users record.
 * Does not return the student's password to the frontend.
 */
router.get("/student-profile/:studentId", async (req, res) => {
    const studentId = normalizeUsn(req.params.studentId);
    const institutionId = getTenant(req.query.institutionId);

    if (!studentId) {
        return res.status(400).json({
            success: false,
            error: "Student ID / USN is required."
        });
    }

    try {
        const studentQuery = `
            SELECT
                usn,
                name,
                email,
                branch,
                semester_number,
                section,
                academic_year,
                institution_id
            FROM users
            WHERE UPPER(TRIM(usn)) = $1
              AND LOWER(TRIM(role)) = 'student'
              AND COALESCE(institution_id, $2) = $2
            LIMIT 1
        `;

        const studentResult = await pool.query(studentQuery, [
            studentId,
            institutionId
        ]);

        if (studentResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Student profile record not found."
            });
        }

        const studentProfile = studentResult.rows[0];

        const academicQuery = `
            SELECT
                semester_number AS semester,
                subject_name,
                subject_code,
                cie1,
                cie2,
                cie3,
                see
            FROM student_marks
            WHERE (
                UPPER(TRIM(student_id)) = $1
                OR UPPER(TRIM(usn)) = $1
            )
              AND COALESCE(institution_id, $2) = $2
            ORDER BY semester_number ASC, subject_code ASC
        `;

        const academicResult = await pool.query(academicQuery, [
            studentId,
            institutionId
        ]);

        const parentQuery = `
            SELECT id, name, email, phone_number, child_usn, institution_id
            FROM users
            WHERE UPPER(TRIM(child_usn)) = $1
              AND LOWER(TRIM(role)) = 'parent'
              AND COALESCE(institution_id, $2) = $2
            ORDER BY created_at DESC NULLS LAST
            LIMIT 1
        `;

        const parentResult = await pool.query(parentQuery, [
            studentId,
            institutionId
        ]);

        return res.json({
            success: true,
            usn: studentProfile.usn,
            student_name: studentProfile.name,
            email: studentProfile.email,
            branch: studentProfile.branch,
            current_class: studentProfile.semester_number,
            semester_number: studentProfile.semester_number,
            section: studentProfile.section,
            academic_year: studentProfile.academic_year,
            institutionId: studentProfile.institution_id || institutionId,
            parent: parentResult.rows[0] || null,
            academic: academicResult.rows
        });
    } catch (err) {
        console.error("Error in combined student-profile route:", err);
        return res.status(500).json({
            success: false,
            error: "Server error while loading the student profile."
        });
    }
});

/**
 * 2. GET ATTENDANCE HISTORY
 * Returns recorded attendance scans for a student.
 */
router.get("/attendance-history/:studentId", async (req, res) => {
    const studentId = normalizeUsn(req.params.studentId);
    const institutionId = getTenant(req.query.institutionId);

    if (!studentId) {
        return res.status(400).json({
            success: false,
            error: "Student ID / USN is required."
        });
    }

    try {
        const query = `
            SELECT subject_name, 'Present' AS status, created_at
            FROM users_attendance
            WHERE UPPER(TRIM(student_id)) = $1
              AND COALESCE(institution_id, $2) = $2
            ORDER BY created_at DESC
        `;

        const result = await pool.query(query, [studentId, institutionId]);
        return res.json(result.rows);
    } catch (err) {
        console.error("History Log Error:", err);
        return res.status(500).json({
            success: false,
            error: "Failed to load attendance history."
        });
    }
});

/**
 * 3. TEACHER ROUTE: ADD OR UPDATE MARKS
 * Keeps the existing ON CONFLICT key and table column structure.
 */
router.post("/update-marks", async (req, res) => {
    const {
        srn,
        sem,
        cie1,
        cie2,
        cie3,
        see,
        subject,
        subjectCode,
        institutionId
    } = req.body || {};

    const tenant = getTenant(institutionId);
    const cleanUsn = normalizeUsn(srn);
    const rawSubject = typeof subject === "string" ? subject.trim() : "";
    const rawSubjectCode = typeof subjectCode === "string"
        ? subjectCode.trim()
        : "";

    if (!cleanUsn || sem === undefined || sem === null ||
        (!rawSubject && !rawSubjectCode)) {
        return res.status(400).json({
            success: false,
            message: "Missing USN, semester, or subject."
        });
    }

    const semester = Number.parseInt(sem, 10);
    if (!Number.isInteger(semester) || semester < 1) {
        return res.status(400).json({
            success: false,
            message: "Semester must be a valid positive number."
        });
    }

    const toMarkValue = (value, fieldName) => {
        if (value === undefined || value === null || value === "") return 0;
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0) {
            throw new Error(`${fieldName} must be a valid non-negative number.`);
        }
        return parsed;
    };

    try {
        const userLookup = await pool.query(
            `SELECT name
             FROM users
             WHERE UPPER(TRIM(usn)) = $1
               AND LOWER(TRIM(role)) = 'student'
               AND COALESCE(institution_id, $2) = $2
             LIMIT 1`,
            [cleanUsn, tenant]
        );

        if (userLookup.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Student was not found for this institution."
            });
        }

        const studentFullName = userLookup.rows[0].name || "Student";
        const code = (rawSubjectCode || rawSubject).toUpperCase();
        const subjectName = rawSubject || rawSubjectCode;

        const marks = [
            toMarkValue(cie1, "CIE1"),
            toMarkValue(cie2, "CIE2"),
            toMarkValue(cie3, "CIE3"),
            toMarkValue(see, "SEE")
        ];

        await pool.query(
            `INSERT INTO student_marks
                (student_id, usn, student_name, subject, subject_code,
                 subject_name, semester_number, cie1, cie2, cie3, see,
                 institution_id)
             VALUES ($1, $1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (student_id, subject_code, semester_number, institution_id)
             DO UPDATE SET
                 usn = EXCLUDED.usn,
                 subject = EXCLUDED.subject,
                 subject_name = EXCLUDED.subject_name,
                 cie1 = EXCLUDED.cie1,
                 cie2 = EXCLUDED.cie2,
                 cie3 = EXCLUDED.cie3,
                 see = EXCLUDED.see,
                 student_name = EXCLUDED.student_name,
                 updated_at = CURRENT_TIMESTAMP`,
            [
                cleanUsn,
                studentFullName,
                code,
                subjectName,
                semester,
                marks[0],
                marks[1],
                marks[2],
                marks[3],
                tenant
            ]
        );

        return res.json({
            success: true,
            message: "Marks updated successfully."
        });
    } catch (err) {
        console.error("Update Marks Error:", err);
        if (err.message && /must be a valid non-negative number/.test(err.message)) {
            return res.status(400).json({
                success: false,
                message: err.message
            });
        }
        return res.status(500).json({
            success: false,
            message: "Failed to save marks to the database."
        });
    }
});

/**
 * 4. UPDATE STUDENT PROFILE
 * Updates name and email. Password update remains supported for compatibility
 * with the current frontend, but should be changed to a password-hashing flow
 * before production use.
 */
router.put("/update-profile/:studentId", async (req, res) => {
    const studentId = normalizeUsn(req.params.studentId);
    const { name, email, password, institutionId } = req.body || {};
    const tenant = getTenant(institutionId);

    if (!studentId) {
        return res.status(400).json({
            success: false,
            message: "Student ID / USN is required."
        });
    }

    if (!name || !email || !password) {
        return res.status(400).json({
            success: false,
            message: "Name, email, and password are required by the current profile form."
        });
    }

    try {
        const updateQuery = `
            UPDATE users
            SET name = $1, email = $2, password = $3
            WHERE UPPER(TRIM(usn)) = $4
              AND LOWER(TRIM(role)) = 'student'
              AND COALESCE(institution_id, $5) = $5
            RETURNING usn, name, email, branch, semester_number, section,
                      academic_year, institution_id
        `;

        const result = await pool.query(updateQuery, [
            name.trim(),
            email.trim(),
            password,
            studentId,
            tenant
        ]);

        if (result.rowCount === 0) {
            return res.status(404).json({
                success: false,
                message: "Student profile record not found."
            });
        }

        return res.status(200).json({
            success: true,
            message: "Profile updated successfully.",
            user: result.rows[0]
        });
    } catch (err) {
        console.error("Profile Edit Error:", err);
        return res.status(500).json({
            success: false,
            message: "Database failure while updating profile."
        });
    }
});

module.exports = router;