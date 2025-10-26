const axios= require("axios");

const VeryfyRecapcha= async (token, action, threshold=0.5)=>{
    const secreKey= process.env.RECAPTCHA_SECRET_KEY;

    if(!secreKey){
        throw new Error("La clave secreta de reCAPTCHA no esta configurado en las variables de entorno");
    }

    try{
        const response= await axios.post(
            "https://www.google.com/recaptcha/api/siteverify",
      null,
      {
        params: {
          secret: secreKey,
          response: token,
        },
        timeout: 5000, 
      }
    );
    const {success, score, action: recaptchaAction, hostname, "error-codes":errorCodes}=response.data;

    if (!success) {
        const errorMessage = errorCodes
          ? `Validación de reCAPTCHA fallida: ${errorCodes.join(", ")}`
          : "Validación de reCAPTCHA fallida: token inválido.";
        throw new Error(errorMessage);
      }

      if (recaptchaAction !== action) {
        throw new Error(`Acción de reCAPTCHA no coincide: esperado ${action}, recibido ${recaptchaAction}`);
      }
  
     
      if (score < threshold) {
        throw new Error(`Puntaje de reCAPTCHA demasiado bajo: ${score} (umbral requerido: ${threshold})`);
      }

      return{
        success:true,
        score,
        hostname,
      };

        
    }catch(error){
        console.error("Error al verficar reCAPTCHA", error.message);
        throw new Error(`Error al verificar reCAPTCHA: ${error.message}`);
    }

}

module.exports = {VeryfyRecapcha};