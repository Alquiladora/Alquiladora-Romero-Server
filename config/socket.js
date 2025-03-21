let io;
const userSockets = {}; // Almacenar sockets de usuarios conectados

module.exports = {
  init: (server) => {
    try {
      io = require("socket.io")(server, {
        cors: {
          origin: [
            "http://localhost:3001",
            "https://alquiladora-romero-server.onrender.com",
            "http://localhost:3000",
            "https://alquiladoraromero.bina5.com",
          ],
          methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS", "PUT"],
          credentials: true,
        },
      });

      io.on("connection", (socket) => {
        console.log(`🔗 Nuevo cliente conectado: ${socket.id}`);

    
        socket.on("usuarioAutenticado", (userId) => {
          console.log(`✅ Usuario ${userId} registrado con el socket ${socket.id}`);
          userSockets[userId] = socket; 
          socket.userId = userId;
        });

  
        socket.on("mensajePrivado", ({ receptorId, mensaje }) => {
          console.log(`📩 Mensaje de ${socket.userId} para ${receptorId}: ${mensaje}`);
          
          if (userSockets[receptorId]) {
            userSockets[receptorId].emit("nuevoMensaje", {
              emisorId: socket.userId,
              mensaje,
            });
          } else {
            console.log(`⚠️ Usuario ${receptorId} no está conectado.`);
          }
        });

        // Manejar desconexión
        socket.on("disconnect", () => {
          console.log(`🔌 Cliente desconectado: ${socket.id}`);
          if (socket.userId) {
            delete userSockets[socket.userId];
          }
        });
      });

      console.log("✅ Socket.io inicializado correctamente");
      return io;
    } catch (error) {
      console.error("❌ Error al inicializar Socket.io:", error);
    }
  },

  getIO: () => {
    if (!io) {
      throw new Error("Socket.io no ha sido inicializado");
    }
    return io;
  },
  getUserSockets: () => userSockets,
 
};
