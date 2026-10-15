package com.drait.portal;

import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.Executor;

@CapacitorPlugin(name = "BiometricAuth")
public class BiometricAuthPlugin extends Plugin {

    @PluginMethod
    public void isAvailable(PluginCall call) {
        try {
            BiometricManager biometricManager = BiometricManager.from(getContext());
            int canAuth = biometricManager.canAuthenticate(
                BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.BIOMETRIC_WEAK
            );

            JSObject ret = new JSObject();
            switch (canAuth) {
                case BiometricManager.BIOMETRIC_SUCCESS:
                    ret.put("available", true);
                    ret.put("status", "AVAILABLE");
                    ret.put("message", "Biometric sensor is ready.");
                    call.resolve(ret);
                    break;
                case BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE:
                    ret.put("available", false);
                    ret.put("status", "NO_HARDWARE");
                    ret.put("message", "This device does not have biometric hardware.");
                    call.resolve(ret);
                    break;
                case BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE:
                    ret.put("available", false);
                    ret.put("status", "HW_UNAVAILABLE");
                    ret.put("message", "Biometric hardware is currently busy or unavailable. Please try again.");
                    call.resolve(ret);
                    break;
                case BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED:
                    ret.put("available", false);
                    ret.put("status", "NONE_ENROLLED");
                    ret.put("message", "No fingerprints enrolled on this phone. Please add a fingerprint in Android Settings -> Security -> Fingerprint.");
                    call.resolve(ret);
                    break;
                case BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED:
                    ret.put("available", false);
                    ret.put("status", "SECURITY_UPDATE_REQUIRED");
                    ret.put("message", "A system security update is required to use biometric authentication.");
                    call.resolve(ret);
                    break;
                default:
                    ret.put("available", false);
                    ret.put("status", "UNSUPPORTED");
                    ret.put("message", "Biometric authentication is not supported on this device.");
                    call.resolve(ret);
                    break;
            }
        } catch (Exception e) {
            JSObject ret = new JSObject();
            ret.put("available", false);
            ret.put("status", "ERROR");
            ret.put("message", e.getMessage());
            call.resolve(ret);
        }
    }

    @PluginMethod
    public void authenticate(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                BiometricManager biometricManager = BiometricManager.from(getContext());
                int canAuth = biometricManager.canAuthenticate(
                    BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.BIOMETRIC_WEAK
                );

                if (canAuth == BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE) {
                    call.reject("NO_HARDWARE: This device does not have a biometric sensor.", "NO_HARDWARE");
                    return;
                } else if (canAuth == BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE) {
                    call.reject("HW_UNAVAILABLE: Biometric sensor is temporarily unavailable. Please try again.", "HW_UNAVAILABLE");
                    return;
                } else if (canAuth == BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED) {
                    call.reject("NONE_ENROLLED: No fingerprints enrolled. Please register a fingerprint in your phone's Android Settings -> Security.", "NONE_ENROLLED");
                    return;
                } else if (canAuth != BiometricManager.BIOMETRIC_SUCCESS) {
                    call.reject("UNAVAILABLE: Biometric authentication is currently unavailable on this device.", "UNAVAILABLE");
                    return;
                }

                String title = call.getString("title", "Dr. AIT Student Verification");
                String subtitle = call.getString("subtitle", "Fingerprint Security Check");
                String description = call.getString("description", "Touch the fingerprint sensor to verify your identity and unlock your portal session.");
                String cancelText = call.getString("cancelText", "Cancel");

                Executor executor = ContextCompat.getMainExecutor(getContext());
                FragmentActivity activity = (FragmentActivity) getActivity();

                BiometricPrompt.PromptInfo promptInfo = new BiometricPrompt.PromptInfo.Builder()
                    .setTitle(title)
                    .setSubtitle(subtitle)
                    .setDescription(description)
                    .setNegativeButtonText(cancelText)
                    .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.BIOMETRIC_WEAK)
                    .build();

                BiometricPrompt biometricPrompt = new BiometricPrompt(activity, executor, new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationError(int errorCode, @NonNull CharSequence errString) {
                        super.onAuthenticationError(errorCode, errString);
                        if (errorCode == BiometricPrompt.ERROR_USER_CANCELED || errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON) {
                            call.reject("USER_CANCELED: Fingerprint scan cancelled by user.", "USER_CANCELED");
                        } else if (errorCode == BiometricPrompt.ERROR_LOCKOUT || errorCode == BiometricPrompt.ERROR_LOCKOUT_PERMANENT) {
                            call.reject("LOCKOUT: Too many failed attempts. Biometric sensor is locked. Unlock using phone lock screen PIN/password.", "LOCKOUT");
                        } else if (errorCode == BiometricPrompt.ERROR_NO_BIOMETRICS) {
                            call.reject("NONE_ENROLLED: No enrolled fingerprints found. Please enroll a fingerprint in Android Settings.", "NONE_ENROLLED");
                        } else {
                            call.reject("AUTH_ERROR: " + errString, "AUTH_ERROR");
                        }
                    }

                    @Override
                    public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                        super.onAuthenticationSucceeded(result);
                        JSObject ret = new JSObject();
                        ret.put("success", true);
                        ret.put("message", "Biometric verification successful.");
                        call.resolve(ret);
                    }

                    @Override
                    public void onAuthenticationFailed() {
                        super.onAuthenticationFailed();
                        // Native system UI prompts user to try again
                    }
                });

                biometricPrompt.authenticate(promptInfo);

            } catch (Exception e) {
                call.reject("Biometric invocation error: " + e.getMessage(), "EXCEPTION");
            }
        });
    }
}

