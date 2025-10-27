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

  // Simular rutas reales
  usuarioRouter.post('/login', (req, res) => {
    // Esta implementación se sobrescribirá en las pruebas
    res.json({ message: 'Mocked login' });
  });
  usuarioRouter.get('/perfil', (req, res) => {
    res.json({ message: 'Mocked perfil' });
  });
  usuarioRouter.get('/perfiles', (req, res) => {
    res.json({ message: 'Mocked perfiles' });
  });

  return {
    verifyToken: jest.fn(),
    obtenerFechaMexico: jest.fn(() => '2025-10-27 10:59:00'),
    usuarioRouter,
  };
});

// Mockear clsPedidos
jest.mock('../consultas/clsPedidos', () => {
  const express = require('express');
  const router = express.Router();

  router.get('/historial-pedidos', (req, res) => {
    res.json({ message: 'Mocked historial-pedidos' });
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
    const mockToken = jwt.sign(mockUser, 'your-secret-key', { expiresIn: '24h' });

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
    expect(res.body).toHaveProperty('message', expect.stringContaining('incorrectos'));
  });

  // Pruebas para /api/usuarios/perfil
  test('GET /api/usuarios/perfil - Devolver perfil con token válido', async () => {
    const userId = 1;
    const mockToken = jwt.sign({ id: userId, nombre: 'Test User', rol: 'user' }, 'your-secret-key', {
      expiresIn: '24h',
    });

    require('../consultas/clsUsuarios').verifyToken.mockImplementation((req, res, next) => {
      req.user = { id: userId, nombre: 'Test User', rol: 'user' };
      next();
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
    expect(res.body).toHaveProperty('message', expect.stringContaining('Token no proporcionado'));
  });

  // Pruebas para /api/usuarios/perfiles
  test('GET /api/usuarios/perfiles - Devolver perfiles con token válido (admin)', async () => {
    const userId = 1;
    const mockToken = jwt.sign({ id: userId, nombre: 'Admin User', rol: 'admin' }, 'your-secret-key', {
      expiresIn: '24h',
    });

    require('../consultas/clsUsuarios').verifyToken.mockImplementation((req, res, next) => {
      req.user = { id: userId, nombre: 'Admin User', rol: 'admin' };
      next();
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

    require('../consultas/clsUsuarios').verifyToken.mockImplementation((req, res, next) => {
      req.user = { id: userId, nombre: 'Test User', rol: 'user' };
      next();
    });

    const res = await request(app)
      .get('/api/usuarios/perfiles')
      .set('Authorization', `Bearer ${mockToken}`);

    expect(res.statusCode).toBe(403);
    expect(res.body).toHaveProperty('message', expect.stringContaining('administrador'));
  });

  // Pruebas para /api/pedidos/historial-pedidos
  test('GET /api/pedidos/historial-pedidos - Devolver pedidos con token válido', async () => {
    const userId = 1;
    const mockToken = jwt.sign({ id: userId, nombre: 'Test User', rol: 'user' }, 'your-secret-key', {
      expiresIn: '24h',
    });

    require('../consultas/clsUsuarios').verifyToken.mockImplementation((req, res, next) => {
      req.user = { id: userId, nombre: 'Test User', rol: 'user' };
      next();
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
    expect(res.body).toHaveProperty('message', expect.stringContaining('Token no proporcionado'));
  });

  test('GET /api/pedidos/historial-pedidos - Devolver lista vacía si no hay pedidos', async () => {
    const userId = 1;
    const mockToken = jwt.sign({ id: userId, nombre: 'Test User', rol: 'user' }, 'your-secret-key', {
      expiresIn: '24h',
    });

    require('../consultas/clsUsuarios').verifyToken.mockImplementation((req, res, next) => {
      req.user = { id: userId, nombre: 'Test User', rol: 'user' };
      next();
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