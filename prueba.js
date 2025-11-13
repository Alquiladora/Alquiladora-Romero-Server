// prueba.js
require('dotenv').config();
const { sendEmail } = require('./email'); // Asegúrate de que se llame 'email.js'

(async () => {
  const result = await sendEmail(
    "20221034@uthh.edu.mx",
    "Prueba de Email",
    "<h1>¡Hola desde Alquiladora Romero!</h1><p>Esto es una prueba.</p>"
  );

  if (result.url) {
    console.log("VE EL EMAIL AQUÍ: ", result.url);
  } else if (result.success) {
    console.log("Email enviado en producción");
  } else {
    console.log("Error:", result.error);
  }
})();