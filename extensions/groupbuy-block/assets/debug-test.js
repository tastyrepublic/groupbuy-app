// debug-test.js
console.log("🚀 [DEBUG] CDN is working! debug-test.js has loaded.");

document.addEventListener("DOMContentLoaded", () => {
  const widget = document.querySelector('.gb-widget');
  if (widget) {
    widget.innerHTML = `
      <div style="padding: 20px; background: #e3f2fd; border: 2px solid #2196f3; border-radius: 8px;">
        <h3 style="margin:0; color: #1976d2;">Diagnostic Tool Active</h3>
        <p>✅ CDN Assets: Working</p>
        <p id="proxy-check">⏳ Checking App Proxy...</p>
      </div>
    `;

    // Test the App Proxy connection
    fetch('/apps/gbs/test')
      .then(res => res.json())
      .then(data => {
        document.getElementById('proxy-check').innerHTML = "✅ App Proxy: Connected (" + data.status + ")";
      })
      .catch(err => {
        document.getElementById('proxy-check').innerHTML = "❌ App Proxy: Failed (" + err.message + ")";
      });
  }
});