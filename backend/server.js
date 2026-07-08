const express = require("express");
const cors = require("cors");
const pool = require("./db"); // Ensure your db.js connection is correct
const app = express();


// 1. MIDDLEWARE
app.use(cors()); 
app.use(express.json()); 

// 2. IMPORT ROUTES
const authRoutes = require("./routes/auth");
const qrModule = require("./routes/qr"); 
const attendanceRoutes = require("./routes/attendance");
const parentAuthRoutes = require("./routes/parentAuth");
const marksRoutes = require("./routes/marks");

// 3. ATTACH ROUTES TO PATHS
app.use("/api/auth", authRoutes);

// We change this to "/api/parent" to match your login.html fetch URL
app.use("/api/parent", parentAuthRoutes); 

// Attendance & QR Logic
app.use("/api/qr", qrModule.router); 
app.use("/api/attendance", attendanceRoutes);

// Academic Records (Marks & Subjects)
app.use("/api/marks", marksRoutes);

// 4. BASE/TEST ROUTE
app.get("/", (req, res) => {
    res.status(200).send("Attendance System Server is Live! 🚀");
});

// 5. GLOBAL ERROR HANDLER
app.use((err, req, res, next) => {
    console.error("Internal Server Error:", err.stack);
    res.status(500).json({ success: false, message: "Something went wrong on the server!" });
});

// 6. START SERVER
const PORT = 5000;
app.listen(PORT, () => {
    console.log("==================================================");
    console.log(`✅ SERVER RUNNING ON: http://localhost:${PORT}`);
    // Updated this log to show /api/parent is actually active
    console.log(`📡 ACTIVE ENDPOINTS: /api/auth, /api/qr, /api/marks, /api/parent`);
    console.log(`👨‍🏫 PORTALS: Teacher, Student, and Parent are READY`);
    console.log("==================================================");
});


module.exports = app;