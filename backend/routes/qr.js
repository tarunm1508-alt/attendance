const express = require("express");
const { database } = require("firebase-admin");
const router = express.Router();

// Shared memory object
let activeQR = {
    token: null,
    expiry: null,
    subject: null
};

router.post("/generate", (req, res) => {
    try {
        const { subject } = req.body;
        const newToken = "QR_" + Math.random().toString(36).substr(2, 9).toUpperCase();
        
        activeQR.token = newToken;
        activeQR.subject = subject || "General Class";
        activeQR.expiry = Date.now() + (10 * 60 * 1000); // 10 mins

        console.log("🆕 NEW QR GENERATED:", activeQR.token);

        res.json({ 
            qr_string: JSON.stringify({ token: newToken, subject: activeQR.subject }) 
        });
    } catch (error) {
        res.status(500).json({ message: "Failed to generate QR" });
    }
});

// CRITICAL: Export properly
module.exports = { router, activeQR };

// For backward compatibility with attendance.js
module.exports.activeQR = activeQR;