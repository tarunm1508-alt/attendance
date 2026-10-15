// 🎯 SERVICE WORKER MODULE FOR REAL APP INSTALLATION
const CACHE_NAME = "ams-portal-v1";
const ASSETS = [
    "login.html",
    "signup.html",
    "student.html",
    "parent.html",
    "style.css",
    "manifest.json"
];

// Install Event Configuration
self.addEventListener("install", (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS);
        })
    );
});

// Activation Event Configuration
self.addEventListener("activate", (e) => {
    console.log("🧬 Biometric PWA Service Worker Fully Active.");
});

// Fetch Interceptor Pipeline Loop
self.addEventListener("fetch", (e) => {
    e.respondWith(
        fetch(e.request).catch(() => caches.match(e.request))
    );
});