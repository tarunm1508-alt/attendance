// 1. API Base URL 
const API_URL = "https://dr-ait-portal-backend.onrender.com/api";

// 2. Logout Function (Used by both Teacher and Student)
function logout() {
    console.log("Logging out...");
    localStorage.clear(); // Clears SRN and Role from browser memory
    window.location.href = "login.html";
}

// 3. User Greeting (Automatically fills the "Welcome" text)
function displayUserGreeting() {
    const studentId = localStorage.getItem("student_id");
    const greetingElement = document.getElementById("userGreeting");
    if (greetingElement && studentId) {
        greetingElement.innerText = studentId;
    }
}

// 4. Protection Guard (Prevents people from skipping the login)
function checkAuth() {
    const role = localStorage.getItem("role");
    // If no role is found, send them back to login
    if (!role && !window.location.href.includes("login.html")) {
        window.location.href = "login.html";
    }
}

// Run these when the page loads
document.addEventListener("DOMContentLoaded", () => {
    if (!window.location.href.includes("login.html")) {
        checkAuth();
        displayUserGreeting();
    }
});