/**
 * Shared Environment Configuration for Academic Biometric Management System
 * Dynamically resolves backend URL across Capacitor Android container, local dev, and Render production.
 */
(function () {
    const isCapacitorAndroid = Boolean(
        (window.Capacitor && (typeof window.Capacitor.isNativePlatform === 'function' ? window.Capacitor.isNativePlatform() : window.Capacitor.getPlatform?.() === 'android')) ||
        window.location.protocol === 'capacitor:' ||
        (window.location.hostname === 'localhost' && !window.location.port)
    );

    const resolvedBase = isCapacitorAndroid
        ? "https://dr-ait-portal-backend.onrender.com"
        : (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
            ? (window.location.port === "5000" ? window.location.origin : "http://localhost:5000")
            : (window.location.origin.includes("-5501.") ? window.location.origin.replace("-5501.", "-5000.") :
               window.location.origin.includes(":5501") ? window.location.origin.replace(":5501", ":5000") :
               window.location.origin);

    window.APP_BACKEND_URL = resolvedBase;
    if (typeof window.API_BASE === 'undefined') window.API_BASE = resolvedBase;
    if (typeof window.BACKEND_URL === 'undefined') window.BACKEND_URL = resolvedBase;
    if (typeof window.API_URL === 'undefined') window.API_URL = resolvedBase + "/api";
})();