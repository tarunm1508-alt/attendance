// 1. API Base URL (Dynamically resolves local vs production Render deployment)
let API_URL = window.location.origin;
if (API_URL.includes("-5501.")) {
    API_URL = API_URL.replace("-5501.", "-5000.") + "/api";
} else if (API_URL.includes(":5501")) {
    API_URL = API_URL.replace(":5501", ":5000") + "/api";
} else if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
    API_URL = "http://localhost:5000/api";
} else {
    API_URL = "https://dr-ait-portal-backend.onrender.com/api";
}

// 2. Logout Function (Clears all stored session credentials)
function logout() {
    console.log("Logging out...");
    localStorage.clear();
    sessionStorage.clear();
    window.location.href = "login.html";
}

// 3. User Greeting (Supports both old and new localStorage keys)
function displayUserGreeting() {
    const studentId = localStorage.getItem("userUsn") || localStorage.getItem("student_id") || localStorage.getItem("usn");
    const greetingElement = document.getElementById("userGreeting");
    if (greetingElement && studentId) {
        greetingElement.innerText = studentId;
    }
}

// 4. Protection Guard (Prevents unauthorized access bypassing login)
function checkAuth() {
    const role = localStorage.getItem("userRole") || localStorage.getItem("role");
    const currentPath = window.location.pathname;
    
    // If no role is found and not already on an auth page, redirect to index/login
    if (!role && !currentPath.includes("login.html") && !currentPath.includes("signup.html") && !currentPath.includes("index.html")) {
        window.location.href = "index.html";
    }
}

// Run these when the page loads
document.addEventListener("DOMContentLoaded", () => {
    const currentPath = window.location.pathname;
    if (!currentPath.includes("login.html") && !currentPath.includes("signup.html") && !currentPath.includes("index.html")) {
        checkAuth();
        displayUserGreeting();
    }
});