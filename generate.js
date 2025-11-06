// generate_vapid.js
const webpush = require('web-push');

// Genera el par de claves (pública y privada)
const vapidKeys = webpush.generateVAPIDKeys();

console.log("--- CLAVE PÚBLICA VAPID (Frontend) ---");
console.log(vapidKeys.publicKey);

console.log("\n--- CLAVE PRIVADA VAPID (Servidor) ---");
console.log(vapidKeys.privateKey);