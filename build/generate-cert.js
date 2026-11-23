/**
 * Generate a Self-Signed Certificate for Windows Code Signing
 * 
 * Run this script ONCE on Windows to create a .pfx certificate:
 *   node build/generate-cert.js
 * 
 * Prerequisites (Windows only):
 *   - PowerShell (included with Windows 10/11)
 *   
 * This will create: build/cert.pfx
 * 
 * After generating, build with:
 *   set CSC_LINK=build/cert.pfx
 *   set CSC_KEY_PASSWORD=BusinessManagerPOS2024
 *   npm run build:win
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const CERT_PASSWORD = 'BusinessManagerPOS2024';
const CERT_NAME = 'Business Manager POS';
const OUTPUT_PFX = path.join(__dirname, 'cert.pfx');

if (process.platform !== 'win64') {
  console.log('⚠️  This script must be run on Windows.');
  console.log('');
  console.log('On Windows, run:');
  console.log('  node build/generate-cert.js');
  console.log('');
  console.log('Or manually generate with PowerShell:');
  console.log(`  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=${CERT_NAME}" -CertStoreLocation "Cert:\\CurrentUser\\My"`);
  console.log(`  $pwd = ConvertTo-SecureString -String "${CERT_PASSWORD}" -Force -AsPlainText`);
  console.log(`  Export-PfxCertificate -Cert $cert -FilePath "${OUTPUT_PFX}" -Password $pwd`);
  process.exit(0);
}

if (fs.existsSync(OUTPUT_PFX)) {
  console.log(`✅ Certificate already exists: ${OUTPUT_PFX}`);
  console.log('Delete it first if you want to regenerate.');
  process.exit(0);
}

console.log('🔐 Generating self-signed code signing certificate...');
console.log(`   Name: ${CERT_NAME}`);
console.log(`   Output: ${OUTPUT_PFX}`);

try {
  // Create self-signed certificate using PowerShell
  const psScript = `
    $cert = New-SelfSignedCertificate \`
      -Type CodeSigningCert \`
      -Subject "CN=${CERT_NAME}" \`
      -CertStoreLocation "Cert:\\CurrentUser\\My" \`
      -NotAfter (Get-Date).AddYears(5);
    $pwd = ConvertTo-SecureString -String "${CERT_PASSWORD}" -Force -AsPlainText;
    Export-PfxCertificate -Cert "Cert:\\CurrentUser\\My\\$($cert.Thumbprint)" -FilePath "${OUTPUT_PFX.replace(/\\/g, '\\\\')}" -Password $pwd;
    Write-Host "Certificate thumbprint: $($cert.Thumbprint)";
  `.trim();

  execSync(`powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`, {
    stdio: 'inherit'
  });

  if (fs.existsSync(OUTPUT_PFX)) {
    console.log('');
    console.log('✅ Certificate generated successfully!');
    console.log('');
    console.log('To build with signing, run:');
    console.log(`  set CSC_LINK=${OUTPUT_PFX}`);
    console.log(`  set CSC_KEY_PASSWORD=${CERT_PASSWORD}`);
    console.log('  npm run build:win');
    console.log('');
    console.log('⚠️  IMPORTANT: Add cert.pfx to .gitignore!');
  } else {
    console.error('❌ Certificate file was not created.');
  }
} catch (err) {
  console.error('❌ Failed to generate certificate:', err.message);
  console.log('');
  console.log('Try running PowerShell as Administrator, or generate manually:');
  console.log(`  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=${CERT_NAME}" -CertStoreLocation "Cert:\\CurrentUser\\My"`);
}
