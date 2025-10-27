
/**
 * Determina el nivel y beneficios de un usuario basado en sus PuntosReales.
 * @param {number} puntosReales - El total de PuntosReales acumulados.
 * @returns {object} Un objeto con { nuevoNivel, nuevosBeneficios }
 */
function determinarNivel(puntosReales) {
  
 
  if (puntosReales >= 5000) {
    return {
      nuevoNivel: "Embajador de Fiesta",
      nuevosBeneficios: "12% de descuento en todas las rentas. Prioridad en las rutas de entrega. Envío gratuito sin mínimo de compra.",
    };
  } 

  else if (puntosReales >= 2000) {
    return {
      nuevoNivel: "Organizador Pro",
      nuevosBeneficios: "10% de descuento en todas las rentas. Prioridad en las rutas de entrega.",
    };
  } 
  
  else if (puntosReales >= 500) {
    return {
      nuevoNivel: "Anfitrión",
      nuevosBeneficios: "5% de descuento en todas las rentas",
    };
  } 
  
  else {
    return {
      nuevoNivel: "Invitado",
      nuevosBeneficios: "Acceso al programa de Puntos y Logros",
    };
  }
}

module.exports = {
  determinarNivel
};