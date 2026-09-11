// 🎯 SERVICE WORKER MODULE FOR REAL APP INSTALLATION
const CACHE_NAME = "ams-portal-v2";
const ASSETS = [
    "index.html",
    "login.html",
    "signup.html",
    "dashboard.html",
    "hod_dashboard.html",
    "parent.html",
    "marks.html",
    "manifest.json"
];

// Install Event Configuration (Forces immediate activation)
self.addEventListener("install", (e) => {
    self.skipWaiting();
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS);
        })
    );
});

// Activation Event Configuration (Cleans up old stale caches)
self.addEventListener("activate", (e) => {
    e.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.map((key) => {
                    if (key !== CACHE_NAME) {
                        return caches.delete(key);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch Interceptor Pipeline Loop (Bypasses external API requests to prevent breaking Render calls)
self.addEventListener("fetch", (e) => {
    if (!e.request.url.startsWith(self.location.origin)) return;
    
    e.respondWith(
        fetch(e.request).catch(() => caches.match(e.request))
    );
});