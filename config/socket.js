
let io;

module.exports = {
  init: (server) => {
    io = require("socket.io")(server, {
      cors: {
        origin: [
          'http://localhost:3001',
          'https://alquiladora-romero-server.onrender.com',
          'http://localhost:3000',
          'https://alquiladoraromero.bina5.com'
        ],
        methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS', 'PUT'],
        credentials: true,
      },
    });

    io.on("connection", (socket) => {
      console.log(`Nuevo cliente conectado: ${socket.id}`);
      socket.emit("mensaje", "Bienvenido al servidor de Socket.IO");
      socket.on("eventoCliente", (data) => {
        console.log("Datos recibidos del cliente:", data);
        io.emit("eventoServidor", data);
      });
      socket.on("disconnect", () => {
        console.log(`Cliente desconectado: ${socket.id}`);
      });
    });

    return io;
  },
  getIO: () => {
    if (!io) {
      throw new Error("Socket.io no ha sido inicializado");
    }
    return io;
  },
};
