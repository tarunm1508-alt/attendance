const express = require("express");
const router = express.Router();

// Shared memory object for active QR sessions with location support
let activeQR = {
    token: null,
    expiry: null,
    subject: null,
    latitude: null,
    longitude: null,
    radius: 50 // allowed radius in meters (default 50m)
};

router.post("/generate", (req, res) => {
    try {
        const { subject, latitude, longitude, radius } = req.body;
        const newToken = "QR_" + Math.random().toString(36).substr(2, 9).toUpperCase();

        activeQR.token = newToken;
        activeQR.subject = subject || "General Class";
        activeQR.expiry = Date.now() + (10 * 60 * 1000); // 10 minutes expiry
        activeQR.latitude = latitude || null;
        activeQR.longitude = longitude || null;
        activeQR.radius = radius || 50;

        console.log("🆕 NEW QR GENERATED:", activeQR.token, "| Location Locked:", !!latitude);

        res.json({ 
            success: true,
            qr_string: JSON.stringify({ 
                token: newToken, 
                subject: activeQR.subject,
                lat: activeQR.latitude,
                lng: activeQR.longitude
            }) 
        });
    } catch (error) {
        console.error("QR Generation Error:", error.message);
        res.status(500).json({ success: false, message: "Failed to generate QR" });
    }
});

// Clean, unified export matching what other modules expect
module.exports = {
    router,
    activeQR
};