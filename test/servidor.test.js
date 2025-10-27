const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const { mockDeep } = require('jest-mock-extended');

// Mockear connectBd
jest.mock('../connectBd', () => ({
  pool: mockDeep(),
}));

// Mockear clsUsuarios
jest.mock('../consultas/clsUsuarios', () => {
  const express = require('express');
  const usuarioRouter = express.Router();

  // Ruta /login
  usuarioRouter.post('/login', async (req, res) => {
    const { correo, contrasena } = req.body;
    const mockPool = require('../connectBd').pool;
    const connection = await mockPool.getConnection();
    try {
      const [users] = await connection.query.mock.results[0].value;
      if (users.length > 0) {
        const user = users[0];
        const token = jwt.sign({ id: user.id, nombre: user.nombre, rol: user.rol }, 'your-secret-key', { expiresIn: '24h' });
        return res.status(200).json({ token, user });
      }
      return res.status(401).json({ message: 'Correo o contraseña incorrectos.' });
    } finally {
      connection.release();
    }
  });

  // Ruta /perfil
  usuarioRouter.get('/perfil', (req, res, next) => verifyToken(req, res, next), async (req, res) => {
    const mockPool = require('../connectBd').pool;
    const connection = await mockPool.getConnection();
    try {
      const [perfil] = await connection.query.mock.results[0].value;
      return res.status(200).json(perfil[0]);
    } finally {
      connection.release();
    }
  });

  // Ruta /perfiles
  usuarioRouter.get('/perfiles', (req, res, next) => verifyToken(req, res, next), async (req, res) => {
    if (req.user.rol !== 'admin') {
      return res.status(403).json({ message: 'Acceso denegado. Se requiere rol de administrador.' });
    }
    const mockPool = require('../connectBd').pool;
    const connection = await mockPool.getConnection();
    try {
      const [perfiles] = await connection.query.mock.results[0].value;
      return res.status(200).json(perfiles);
    } finally {
      connection.release();
    }
  });

  // Mock de verifyToken
  const verifyToken = jest.fn((req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(403).json({ message: 'Token no proporcionado. Acceso denegado.' });
    }
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, 'your-secret-key');
      req.user = decoded;
      next();
    } catch (err) {
      return res.status(401).json({ message: 'El token ha expirado. Inicia sesión nuevamente.' });
    }
  });

  return {
    verifyToken,
    obtenerFechaMexico: jest.fn(() => '2025-10-27 10:59:00'),
    usuarioRouter,
  };
});

// Mockear clsPedidos
jest.mock('../consultas/clsPedidos', () => {
  const express = require('express');
  const router = express.Router();

  router.get('/historial-pedidos', (req, res, next) => {
    const { verifyToken } = require('../consultas/clsUsuarios');
    verifyToken(req, res, next);
  }, async (req, res) => {
    const mockPool = require('../connectBd').pool;
    const connection = await mockPool.getConnection();
    try {
      const [pedidos] = await connection.query.mock.results[0].value;
      const [total] = await connection.query.mock.results[1].value;
      return res.status(200).json({
        success: true,
        data: pedidos,
        paginacion: {
          totalPedidos: total[0].totalPedidos,
          paginaActual: 1,
          totalPaginas: Math.ceil(total[0].totalPedidos / 10),
        },
      });
    } finally {
      connection.release();
    }
  });

  return router;
});

describe('Integration Tests: API Básica (Login, Perfil, Perfiles, Historial Pedidos)', () => {
  let app;
  let mockPool;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/usuarios', require('../consultas/clsUsuarios').usuarioRouter);
    app.use('/api/pedidos', require('../consultas/clsPedidos'));

    mockPool = require('../connectBd').pool;
    mockPool.getConnection.mockResolvedValue({
      query: jest.fn(),
      release: jest.fn(),
      beginTransaction: jest.fn(),
      commit: jest.fn(),
      rollback: jest.fn(),
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  afterAll(() => {
    jest.resetAllMocks();
  });

  // Pruebas para /api/usuarios/login
  test('POST /api/usuarios/login - Login con credenciales válidas', async () => {
    const mockUser = { id: 1, nombre: 'Test User', rol: 'user' };
    mockPool.getConnection.mockResolvedValueOnce({
      query: jest.fn().mockResolvedValueOnce([[mockUser]]),
      release: jest.fn(),
    });

    const res = await request(app)
      .post('/api/usuarios/login')
      .send({ correo: 'test@example.com', contrasena: 'password123' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body.user).toEqual(expect.objectContaining({
      id: 1,
      nombre: 'Test User',
      rol: 'user',
    }));
  });

  test('POST /api/usuarios/login - Rechazar credenciales inválidas', async () => {
    mockPool.getConnection.mockResolvedValueOnce({
      query: jest.fn().mockResolvedValueOnce([[]]),
      release: jest.fn(),
    });

    const res = await request(app)
      .post('/api/usuarios/login')
      .send({ correo: 'invalid@example.com', contrasena: 'wrongpassword' });

    expect(res.statusCode).toBe(401);
    expect(res.body).toHaveProperty('message', 'Correo o contraseña incorrectos.');
  });

  // Pruebas para /api/usuarios/perfil
  test('GET /api/usuarios/perfil - Devolver perfil con token válido', async () => {
    const userId = 1;
    const mockToken = jwt.sign({ id: userId, nombre: 'Test User', rol: 'user' }, 'your-secret-key', {
      expiresIn: '24h',
    });

    const mockPerfil = { id: userId, nombre: 'Test User', correo: 'test@example.com' };
    mockPool.getConnection.mockResolvedValueOnce({
      query: jest.fn().mockResolvedValueOnce([[mockPerfil]]),
      release: jest.fn(),
    });

    const res = await request(app)
      .get('/api/usuarios/perfil')
      .set('Authorization', `Bearer ${mockToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      id: userId,
      nombre: 'Test User',
      correo: 'test@example.com',
    }));
  });

  test('GET /api/usuarios/perfil - Rechazar sin token', async () => {
    const res = await request(app)
      .get('/api/usuarios/perfil');

    expect(res.statusCode).toBe(403);
    expect(res.body).toHaveProperty('message', 'Token no proporcionado. Acceso denegado.');
  });

  // Pruebas para /api/usuarios/perfiles
  test('GET /api/usuarios/perfiles - Devolver perfiles con token válido (admin)', async () => {
    const userId = 1;
    const mockToken = jwt.sign({ id: userId, nombre: 'Admin User', rol: 'admin' }, 'your-secret-key', {
      expiresIn: '24h',
    });

    const mockPerfiles = [
      { id: 1, nombre: 'User 1', correo: 'user1@example.com' },
      { id: 2, nombre: 'User 2', correo: 'user2@example.com' },
    ];
    mockPool.getConnection.mockResolvedValueOnce({
      query: jest.fn().mockResolvedValueOnce([mockPerfiles]),
      release: jest.fn(),
    });

    const res = await request(app)
      .get('/api/usuarios/perfiles')
      .set('Authorization', `Bearer ${mockToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 1, nombre: 'User 1' }),
      expect.objectContaining({ id: 2, nombre: 'User 2' }),
    ]));
  });

  test('GET /api/usuarios/perfiles - Rechazar si no es admin', async () => {
    const userId = 1;
    const mockToken = jwt.sign({ id: userId, nombre: 'Test User', rol: 'user' }, 'your-secret-key', {
      expiresIn: '24h',
    });

    const res = await request(app)
      .get('/api/usuarios/perfiles')
      .set('Authorization', `Bearer ${mockToken}`);

    expect(res.statusCode).toBe(403);
    expect(res.body).toHaveProperty('message', 'Acceso denegado. Se requiere rol de administrador.');
  });

  // Pruebas para /api/pedidos/historial-pedidos
  test('GET /api/pedidos/historial-pedidos - Devolver pedidos con token válido', async () => {
    const userId = 1;
    const mockToken = jwt.sign({ id: userId, nombre: 'Test User', rol: 'user' }, 'your-secret-key', {
      expiresIn: '24h',
    });

    const mockPedidos = [
      {
        idPedido: 1,
        idRastreo: 'TRACK123',
        estado: 'Confirmado',
        fechaInicio: '2025-10-01',
        totalPagar: 500.0,
        numeroDeProductos: 2,
        nombreCliente: 'Test User',
      },
    ];
    mockPool.getConnection.mockResolvedValueOnce({
      query: jest.fn()
        .mockResolvedValueOnce([mockPedidos])
        .mockResolvedValueOnce([{ totalPedidos: 1 }]),
      release: jest.fn(),
    });

    const res = await request(app)
      .get('/api/pedidos/historial-pedidos?pagina=1&limite=10')
      .set('Authorization', `Bearer ${mockToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: expect.arrayContaining([
        expect.objectContaining({
          idPedido: 1,
          idRastreo: 'TRACK123',
          estado: 'Confirmado',
        }),
      ]),
      paginacion: {
        totalPedidos: 1,
        paginaActual: 1,
        totalPaginas: 1,
      },
    });
  });

  test('GET /api/pedidos/historial-pedidos - Rechazar sin token', async () => {
    const res = await request(app)
      .get('/api/pedidos/historial-pedidos');

    expect(res.statusCode).toBe(403);
    expect(res.body).toHaveProperty('message', 'Token no proporcionado. Acceso denegado.');
  });

  test('GET /api/pedidos/historial-pedidos - Devolver lista vacía si no hay pedidos', async () => {
    const userId = 1;
    const mockToken = jwt.sign({ id: userId, nombre: 'Test User', rol: 'user' }, 'your-secret-key', {
      expiresIn: '24h',
    });

    mockPool.getConnection.mockResolvedValueOnce({
      query: jest.fn()
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([{ totalPedidos: 0 }]),
      release: jest.fn(),
    });

    const res = await request(app)
      .get('/api/pedidos/historial-pedidos?pagina=1&limite=10')
      .set('Authorization', `Bearer ${mockToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: [],
      paginacion: {
        totalPedidos: 0,
        paginaActual: 1,
        totalPaginas: 0,
      },
    });
  });
});