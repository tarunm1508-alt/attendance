const express = require("express");
const router = express.Router();
const pool = require("../db");

/**
 * 1. GET COMBINED STUDENT PROFILE, MARKS, & PARENT INFO
 * Fetches master credentials from 'users', marks from 'student_marks',
 * and tenant metadata dynamically.
 */
router.get("/student-profile/:studentId", async (req, res) => {
    const { studentId } = req.params;
    const institutionId = req.query.institutionId || 'DR_AIT';

    if (!studentId) {
        return res.status(400).json({ error: "Student ID / USN is required" });
    }

    try {
        // A. Fetch updated student details straight from the master users table
        const studentQuery = `
            SELECT usn, name, email, password, branch, semester_number, section, institution_id 
            FROM users 
            WHERE UPPER(usn) = UPPER($1) 
              AND role = 'student'
              AND COALESCE(institution_id, 'DR_AIT') ILIKE $2
        `;
        const studentResult = await pool.query(studentQuery, [studentId, institutionId]);

        if (studentResult.rows.length === 0) {
            return res.status(404).json({ message: "Student profile record not found." });
        }

        const studentProfile = studentResult.rows[0];

        // B. Fetch academic marks from student_marks table
        const academicQuery = `
            SELECT semester_number AS semester, subject_name, subject_code, cie1, cie2, cie3, see 
            FROM student_marks 
            WHERE (UPPER(student_id) = UPPER($1) OR UPPER(usn) = UPPER($1))
              AND COALESCE(institution_id, 'DR_AIT') ILIKE $2
            ORDER BY semester_number ASC, subject_code ASC
        `;
        const academicResult = await pool.query(academicQuery, [studentId, institutionId]);

        // C. Fetch linked parent metadata if it exists
        const parentRes = await pool.query(
            "SELECT * FROM users WHERE UPPER(child_usn) = UPPER($1) AND role = 'parent' AND COALESCE(institution_id, 'DR_AIT') ILIKE $2", 
            [studentId, institutionId]
        );

        // Deliver clean, unified response object to frontend configurations
        res.json({
            student_name: studentProfile.name,
            email: studentProfile.email,
            password: studentProfile.password,
            branch: studentProfile.branch,
            current_class: studentProfile.semester_number || 3,
            section: studentProfile.section || 'A',
            parent: parentRes.rows[0] || null,
            academic: academicResult.rows
        });

    } catch (err) {
        console.error("Error in combined student-profile route:", err.message);
        res.status(500).json({ error: "Server error compiling profile payload structures." });
    }
});

/**
 * 2. GET ATTENDANCE TIMELINE HISTORY LOGS
 * Fetches chronological scan data from users_attendance to display the timeline stream.
 */
router.get("/attendance-history/:studentId", async (req, res) => {
    const { studentId } = req.params;
    const institutionId = req.query.institutionId || 'DR_AIT';
    try {
        const query = `
            SELECT subject_name, 'Present' AS status, created_at 
            FROM users_attendance 
            WHERE UPPER(student_id) = UPPER($1) 
              AND COALESCE(institution_id, 'DR_AIT') ILIKE $2
            ORDER BY created_at DESC
        `;
        const result = await pool.query(query, [studentId, institutionId]);
        res.json(result.rows);
    } catch (err) {
        console.error("History Log Error:", err.message);
        res.status(500).json({ error: "Failed to load timeline records." });
    }
});

/**
 * 3. TEACHER ROUTE: ADD OR UPDATE MARKS
 * Uses UPSERT logic based on compound unique keys in student_marks table.
 */
router.post("/update-marks", async (req, res) => {
    const { srn, sem, cie1, cie2, cie3, see, subject, subjectCode, institutionId } = req.body;
    const tenant = institutionId || 'DR_AIT';

    if (!srn || !sem || (!subject && !subjectCode)) {
        return res.status(400).json({ success: false, message: "Missing SRN, Semester, or Subject" });
    }

    try {
        const cleanUsn = srn.trim().toUpperCase();
        const code = (subjectCode || subject).trim().toUpperCase();
        const name = subject || subjectCode || code;

        // Get student name
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
             DO UPDATE SET 
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
                parseInt(sem) || 3, 
                parseFloat(cie1) || 0, 
                parseFloat(cie2) || 0, 
                parseFloat(cie3) || 0, 
                parseFloat(see) || 0, 
                tenant
            ]
        );
        
        res.json({ success: true, message: "Marks updated successfully!" });
    } catch (err) {
        console.error("Update Error:", err.message);
        res.status(500).json({ success: false, message: "Failed to save marks to database" });
    }
});

/**
 * 4. PUT ENDPOINT: MODIFY PROFILE METADATA
 * Rewrites core user credentials safely inside the primary users table.
 */
router.put("/update-profile/:studentId", async (req, res) => {
    const { studentId } = req.params;
    const { name, email, password, institutionId } = req.body;
    const tenant = institutionId || 'DR_AIT';

    if (!name || !email || !password) {
        return res.status(400).json({ success: false, message: "All profile fields are required." });
    }

    try {
        const updateQuery = `
            UPDATE users 
            SET name = $1, email = $2, password = $3 
            WHERE UPPER(usn) = UPPER($4) 
              AND role = 'student' 
              AND COALESCE(institution_id, 'DR_AIT') ILIKE $5
            RETURNING usn, name, email
        `;
        const result = await pool.query(updateQuery, [name, email, password, studentId, tenant]);

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: "Student record profile not found." });
        }

        console.log(`Profile successfully updated in DB for Student USN: ${studentId}`);
        
        return res.status(200).json({ 
            success: true, 
            message: "Profile updated successfully inside database! ✅",
            user: result.rows[0]
        });

    } catch (err) {
        console.error("Profile Edit Error:", err.message);
        return res.status(500).json({ success: false, message: "Database failure updating details." });
    }
});

module.exports = router;