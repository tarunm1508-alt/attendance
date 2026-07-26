let API_URL;

// Check if running inside Capacitor Android container
if (window.Capacitor && window.Capacitor.getPlatform() === 'android') {
    API_URL = "https://dr-ait-portal-backend.onrender.com/api";
} else if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    // Local testing on laptop (change port if your backend runs on a different port like 5000)
    API_URL = "http://localhost:5000/api"; 
} else {
    // Production web deployment
    API_URL = "https://dr-ait-portal-backend.onrender.com/api";
}