const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cloudinary = require('cloudinary').v2;

// Load environment variables if not already loaded
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// Configure Cloudinary if credentials are provided
const isCloudinaryConfigured = () => {
    return Boolean(
        process.env.CLOUDINARY_CLOUD_NAME &&
        process.env.CLOUDINARY_API_KEY &&
        process.env.CLOUDINARY_API_SECRET
    );
};

if (isCloudinaryConfigured()) {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
        secure: true
    });
}

// 🛡️ IN-MEMORY STORAGE FOR SECURITY (Buffers handled directly in RAM, no unmanaged disk files)
const storage = multer.memoryStorage();

// File size limit: 2 MB
const MAX_FILE_SIZE = 2 * 1024 * 1024;

// Allowed MIME types
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const fileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = ['.jpg', '.jpeg', '.png', '.webp'];

    if (!allowedExts.includes(ext) || !ALLOWED_MIME_TYPES.includes(file.mimetype)) {
        return cb(new Error('Invalid file format. Only JPEG, PNG, and WebP images are allowed.'), false);
    }
    cb(null, true);
};

const upload = multer({
    storage,
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter
});

/**
 * Validates the true binary magic numbers of an image buffer.
 * Defends against file extension spoofing (e.g., executable disguised as .png).
 */
function validateImageMagicBytes(buffer) {
    if (!buffer || buffer.length < 12) {
        return { valid: false, error: 'File buffer is too small or empty.' };
    }

    // JPEG / JPG check: FF D8 FF
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
        return { valid: true, format: 'jpeg', mime: 'image/jpeg' };
    }

    // PNG check: 89 50 4E 47 0D 0A 1A 0A
    if (
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4E &&
        buffer[3] === 0x47 &&
        buffer[4] === 0x0D &&
        buffer[5] === 0x0A &&
        buffer[6] === 0x1A &&
        buffer[7] === 0x0A
    ) {
        return { valid: true, format: 'png', mime: 'image/png' };
    }

    // WebP check: starts with 'RIFF' and bytes 8..11 are 'WEBP'
    const riff = buffer.toString('ascii', 0, 4);
    const webp = buffer.toString('ascii', 8, 12);
    if (riff === 'RIFF' && webp === 'WEBP') {
        return { valid: true, format: 'webp', mime: 'image/webp' };
    }

    return {
        valid: false,
        error: 'Security rejection: Uploaded file signature does not match a valid JPEG, PNG, or WebP image.'
    };
}

/**
 * Sanitizes and generates a safe unique storage key.
 */
function generateSafeStorageName(tenant, usn, format) {
    const safeTenant = String(tenant || 'DR_AIT').replace(/[^a-zA-Z0-9_-]/g, '');
    const safeUsn = String(usn || 'STUDENT').replace(/[^a-zA-Z0-9_-]/g, '');
    const timestamp = Date.now();
    const randomHex = Math.random().toString(16).substring(2, 8);
    return `${safeTenant}_${safeUsn}_${timestamp}_${randomHex}`;
}

/**
 * Uploads a validated image buffer to Cloudinary (or local fallback if Cloudinary is not configured).
 */
async function uploadProfilePhoto(fileBuffer, param2 = {}, param3 = null, param4 = null) {
    let tenant = 'DR_AIT';
    let usn = 'USER';
    let format = 'jpg';

    if (param2 && typeof param2 === 'object') {
        tenant = param2.tenant || 'DR_AIT';
        usn = param2.usn || param2.userId || 'USER';
        format = param2.format || 'jpg';
    } else {
        if (typeof param2 === 'string') {
            if (param2.includes('/')) {
                format = param2.split('/')[1] || 'jpg';
            } else {
                format = param2;
            }
            if (format === 'jpeg') format = 'jpg';
        }
        if (param3) usn = param3;
        if (param4) tenant = param4;
    }

    const storageName = generateSafeStorageName(tenant, usn, format);

    if (isCloudinaryConfigured()) {
        return new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream(
                {
                    folder: 'attendance_system/student_profiles',
                    public_id: storageName,
                    resource_type: 'image',
                    format: format || 'jpg',
                    overwrite: false,
                    transformation: [
                        { width: 500, height: 500, crop: 'limit', quality: 'auto:good' }
                    ]
                },
                (error, result) => {
                    if (error) {
                        console.error('Cloudinary upload error:', error);
                        return reject(new Error('Cloudinary upload failed: ' + (error.message || 'Unknown error')));
                    }
                    resolve({
                        url: result.secure_url,
                        secure_url: result.secure_url,
                        publicId: result.public_id,
                        provider: 'cloudinary'
                    });
                }
            );

            uploadStream.end(fileBuffer);
        });
    }

    // 🛡️ LOCAL FALLBACK (When Cloudinary credentials are not yet set in .env)
    const localUploadsDir = path.resolve(__dirname, '../../frontend/uploads/profiles');
    if (!fs.existsSync(localUploadsDir)) {
        fs.mkdirSync(localUploadsDir, { recursive: true });
    }

    const filename = `${storageName}.${format || 'jpg'}`;
    const filePath = path.join(localUploadsDir, filename);

    await fs.promises.writeFile(filePath, fileBuffer);

    return {
        url: `/uploads/profiles/${filename}`,
        secure_url: `/uploads/profiles/${filename}`,
        publicId: filename,
        provider: 'local'
    };
}

/**
 * Clean up an uploaded image if database account creation fails after upload.
 */
async function deleteProfilePhoto(uploadResult) {
    if (!uploadResult) return;

    try {
        if (uploadResult.provider === 'cloudinary' && uploadResult.publicId) {
            await cloudinary.uploader.destroy(uploadResult.publicId);
            console.log(`Cleaned up Cloudinary image: ${uploadResult.publicId}`);
        } else if (uploadResult.provider === 'local' && uploadResult.publicId) {
            const localFile = path.resolve(__dirname, '../../frontend/uploads/profiles', uploadResult.publicId);
            if (fs.existsSync(localFile)) {
                await fs.promises.unlink(localFile);
                console.log(`Cleaned up local image file: ${localFile}`);
            }
        }
    } catch (cleanupErr) {
        console.warn('Warning: Failed to clean up orphan image after rollback:', cleanupErr.message);
    }
}

/**
 * Express middleware wrapper to safely process single photo upload while handling Multer errors.
 * Accepts 'profilePhoto', 'photo', or 'file' form field.
 */
const profilePhotoUploadMiddleware = (req, res, next) => {
    // If request is not multipart/form-data, pass through immediately (e.g. JSON requests)
    if (!req.is('multipart/form-data')) {
        return next();
    }

    const uploadMulti = upload.fields([
        { name: 'profilePhoto', maxCount: 1 },
        { name: 'photo', maxCount: 1 },
        { name: 'file', maxCount: 1 }
    ]);

    uploadMulti(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({
                    success: false,
                    message: 'Image size exceeds the maximum limit of 2 MB. Please choose a smaller photo.'
                });
            }
            return res.status(400).json({
                success: false,
                message: `Upload error: ${err.message}`
            });
        } else if (err) {
            return res.status(400).json({
                success: false,
                message: err.message || 'File upload failed.'
            });
        }

        if (req.files) {
            req.file = req.files['profilePhoto']?.[0] || req.files['photo']?.[0] || req.files['file']?.[0] || null;
        }

        next();
    });
};

module.exports = {
    isCloudinaryConfigured,
    validateImageMagicBytes,
    uploadProfilePhoto,
    deleteProfilePhoto,
    profilePhotoUploadMiddleware,
    MAX_FILE_SIZE
};

