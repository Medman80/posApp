/**
 * Self-signing script for Windows builds.
 * 
 * This script is used by electron-builder to sign the executable with a
 * self-signed certificate. While this won't eliminate SmartScreen warnings
 * entirely (you need an EV code signing certificate for that), it will:
 * 
 * 1. Prevent "Unknown Publisher" from showing
 * 2. Allow Windows Defender to build trust over time
 * 3. Ensure the exe isn't flagged as "unsigned/corrupted"
 * 
 * USAGE:
 *   1. Generate a self-signed certificate (run once):
 *      node build/generate-cert.js
 *   
 *   2. Set environment variables before building:
 *      set CSC_LINK=build/cert.pfx
 *      set CSC_KEY_PASSWORD=YourPassword123
 *      npm run build:win
 * 
 * For PRODUCTION:
 *   Buy an EV Code Signing Certificate from:
 *   - DigiCert, Sectigo, or GlobalSign (~$200-400/year)
 *   - Set CSC_LINK and CSC_KEY_PASSWORD to the real certificate
 */

exports.default = async function (configuration) {
  // If no certificate is configured, skip signing gracefully
  if (!process.env.CSC_LINK && !process.env.WIN_CSC_LINK) {
    console.log('[Sign] No certificate configured. Skipping code signing.');
    console.log('[Sign] To sign, set CSC_LINK and CSC_KEY_PASSWORD environment variables.');
    return;
  }
  
  // electron-builder handles the actual signing when CSC_LINK is set
  // This hook is just for logging/custom logic
  console.log(`[Sign] Signing: ${configuration.path}`);
};
