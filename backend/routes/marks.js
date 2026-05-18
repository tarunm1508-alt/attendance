const express = require("express");
const router = express.Router();
const pool = require("../db");

/**
 * 1. GET COMBINED STUDENT PROFILE, MARKS, & PARENT INFO
 * Fetches updated master credentials from 'users', marks from 'marks',
 * and safety records from 'parent_details' dynamically.
 */
router.get("/student-profile/:studentId", async (req, res) => {
    const { studentId } = req.params;

    if (!studentId) {
        return res.status(400).json({ error: "Student ID / USN is required" });
    }

    try {
        // A. Fetch updated student details straight from the master users table
        const studentQuery = `
            SELECT usn, name, email, password, branch, current_class, section 
            FROM users 
            WHERE usn = $1 AND role = 'student'
        `;
        const studentResult = await pool.query(studentQuery, [studentId]);

        if (studentResult.rows.length === 0) {
            return res.status(404).json({ message: "Student profile record not found." });
        }

        const studentProfile = studentResult.rows[0];

        // B. Fetch academic marks & attendance info
        const academicQuery = `
            SELECT semester, subject_name, cie_1, cie_2, cie_3, lab_marks, see_marks, attended_classes, total_classes 
            FROM marks 
            WHERE student_id = $1
            ORDER BY semester ASC, subject_name ASC
        `;
        const academicResult = await pool.query(academicQuery, [studentId]);

        // C. Optional: Fetch linked parent metadata if it exists
        const parentRes = await pool.query(
            "SELECT * FROM parent_details WHERE student_srn = $1", 
            [studentId]
        );

        // Deliver clean, unified response object to frontend configurations
        res.json({
            student_name: studentProfile.name,
            email: studentProfile.email,
            password: studentProfile.password,
            branch: studentProfile.branch,
            current_class: studentProfile.current_class,
            section: studentProfile.section,
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
 * Fetches chronological raw scan data to display the dynamic calendar stream.
 */
router.get("/attendance-history/:studentId", async (req, res) => {
    const { studentId } = req.params;
    try {
        const query = `
            SELECT subject_name, status, created_at 
            FROM attendance 
            WHERE usn = $1 
            ORDER BY created_at DESC
        `;
        const result = await pool.query(query, [studentId]);
        res.json(result.rows);
    } catch (err) {
        console.error("History Log Error:", err.message);
        res.status(500).json({ error: "Failed to load timeline records." });
    }
});

/**
 * 3. TEACHER ROUTE: ADD OR UPDATE MARKS
 * Uses UPSERT logic based on compound unique keys to modify metrics safely.
 */
router.post("/update-marks", async (req, res) => {
    const { srn, sem, cie1, cie2, cie3, lab, see, subject, att_present, att_total } = req.body;

    if (!srn || !sem || !subject) {
        return res.status(400).json({ success: false, message: "Missing SRN, Semester, or Subject" });
    }

    try {
        await pool.query(
            `INSERT INTO marks (student_id, semester, cie_1, cie_2, cie_3, lab_marks, see_marks, subject_name, attended_classes, total_classes) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (student_id, semester, subject_name) 
             DO UPDATE SET 
                cie_1 = EXCLUDED.cie_1, 
                cie_2 = EXCLUDED.cie_2, 
                cie_3 = EXCLUDED.cie_3, 
                lab_marks = EXCLUDED.lab_marks, 
                see_marks = EXCLUDED.see_marks,
                attended_classes = EXCLUDED.attended_classes,
                total_classes = EXCLUDED.total_classes`,
            [srn, sem, cie1 || 0, cie2 || 0, cie3 || 0, lab || 0, see || 0, subject, att_present || 0, att_total || 0]
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
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
        return res.status(400).json({ success: false, message: "All profile fields are required." });
    }

    try {
        const updateQuery = `
            UPDATE users 
            SET name = $1, email = $2, password = $3 
            WHERE usn = $4 AND role = 'student' 
            RETURNING usn, name, email
        `;
        const result = await pool.query(updateQuery, [name, email, password, studentId]);

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