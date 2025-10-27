const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const { mockDeep } = require('jest-mock-extended');

// Importar los routers directamente
const usuarioRouter = require('../consultas/clsUsuarios').usuarioRouter;
const routerPedidos = require('../consultas/clsPedidos');
const { pool } = require('../connectBd');

const SECRET_KEY = process.env.JWT_SECRET || 'your-secret-key';

// Mockear connectBd
jest.mock('../connectBd', () => ({
  pool: mockDeep(),
}));

// Mockear clsUsuarios (sin referenciar express fuera del ámbito)
jest.mock('../consultas/clsUsuarios', () => {
  const mockRouter = jest.fn((req, res, next) => {
    res.json({ message: 'Mocked usuario route' });
  });
  return {
    verifyToken: jest.fn(),
    obtenerFechaMexico: jest.fn(() => '2025-10-27 10:59:00'),
    usuarioRouter: { get: mockRouter, post: mockRouter }, // Mock simple para usuarioRouter
  };
});

// Mockear clsPedidos (si es necesario, aunque ya lo importamos directamente)
jest.mock('../consultas/clsPedidos', () => {
  const mockRouter = jest.fn((req, res, next) => {
    res.json({ message: 'Mocked pedidos route' });
  });
  return { get: mockRouter };
});

describe('Integration Tests: API Básica (Login, Perfil, Perfiles, Historial Pedidos)', () => {
  let app;
  let mockPool;

  beforeAll(() => {
    // Inicializar la aplicación Express
    app = express();
    app.use(express.json());
    app.use('/api/usuarios', usuarioRouter);
    app.use('/api/pedidos', routerPedidos);

    // Configurar el mock del pool
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
    jest.clearAllTimers(); // Limpiar temporizadores para evitar operaciones asíncronas abiertas
  });

  afterAll(() => {
    jest.resetAllMocks();
  });

  // Prueba para /api/usuarios/login
  test('Prueba Positiva: POST /api/usuarios/login - Debe permitir login con credenciales válidas', async () => {
    const mockUser = { id: 1, nombre: 'Test User', rol: 'user' };
    const mockToken = jwt.sign(mockUser, SECRET_KEY, { expiresIn: '24h' });

    require('../consultas/clsUsuarios').verifyToken.mockImplementation((req, res, next) => {
      req.user = mockUser;
      next();
    });

    mockPool.getConnection.mockResolvedValueOnce({
      query: jest.fn().mockResolvedValueOnce([[mockUser]]), // Simula usuario encontrado
      release: jest.fn(),
    });

    const res = await request(app)
      .post('/api/usuarios/login')
      .send({ correo: 'test@example.com', contrasena: 'password123' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body.user).toEqual(expect.objectContaining(mockUser));
  });

  test('Prueba Negativa: POST /api/usuarios/login - Debe rechazar credenciales inválidas', async () => {
    mockPool.getConnection.mockResolvedValueOnce({
      query: jest.fn().mockResolvedValueOnce([[]]), // Simula usuario no encontrado
      release: jest.fn(),
    });

    const res = await request(app)
      .post('/api/usuarios/login')
      .send({ correo: 'invalid@example.com', contrasena: 'wrongpassword' });

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({
      message: 'Correo o contraseña incorrectos.',
    });
  });

  // Prueba para /api/usuarios/perfil
  test('Prueba Positiva: GET /api/usuarios/perfil - Debe devolver el perfil del usuario con token válido', async () => {
    const userId = 1;
    const mockToken = jwt.sign({ id: userId, nombre: 'Test User', rol: 'user' }, SECRET_KEY, {
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
    expect(res.body).toEqual(expect.objectContaining(mockPerfil));
  });

  test('Prueba Negativa: GET /api/usuarios/perfil - Debe rechazar sin token', async () => {
    const res = await request(app)
      .get('/api/usuarios/perfil')
      .send();

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      message: 'Token no proporcionado. Acceso denegado.',
    });
  });

  // Prueba para /api/usuarios/perfiles
  test('Prueba Positiva: GET /api/usuarios/perfiles - Debe devolver lista de perfiles con token válido', async () => {
    const userId = 1;
    const mockToken = jwt.sign({ id: userId, nombre: 'Test User', rol: 'admin' }, SECRET_KEY, {
      expiresIn: '24h',
    });

    require('../consultas/clsUsuarios').verifyToken.mockImplementation((req, res, next) => {
      req.user = { id: userId, nombre: 'Test User', rol: 'admin' };
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
    expect(res.body).toEqual(mockPerfiles);
  });

  test('Prueba Negativa: GET /api/usuarios/perfiles - Debe rechazar si no es admin', async () => {
    const userId = 1;
    const mockToken = jwt.sign({ id: userId, nombre: 'Test User', rol: 'user' }, SECRET_KEY, {
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
    expect(res.body).toEqual({
      message: 'Acceso denegado. Se requiere rol de administrador.',
    });
  });

  // Prueba para /api/pedidos/historial-pedidos
  test('Prueba Positiva: GET /api/pedidos/historial-pedidos - Debe devolver pedidos con token válido', async () => {
    const userId = 1;
    const mockToken = jwt.sign({ id: userId, nombre: 'Test User', rol: 'user' }, SECRET_KEY, {
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
        fotosProductos: ['http://example.com/photo1.jpg', 'http://example.com/photo2.jpg'],
      },
    ];

    const mockTotal = [{ totalPedidos: 1 }];

    mockPool.getConnection.mockResolvedValueOnce({
      query: jest.fn()
        .mockResolvedValueOnce([mockPedidos])
        .mockResolvedValueOnce([mockTotal]),
      release: jest.fn(),
    });

    const res = await request(app)
      .get('/api/pedidos/historial-pedidos?pagina=1&limite=10')
      .set('Authorization', `Bearer ${mockToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: mockPedidos,
      paginacion: {
        totalPedidos: 1,
        paginaActual: 1,
        totalPaginas: 1,
      },
    });
  });

  test('Prueba Negativa: GET /api/pedidos/historial-pedidos - Debe rechazar sin token', async () => {
    const res = await request(app)
      .get('/api/pedidos/historial-pedidos')
      .send();

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      message: 'Token no proporcionado. Acceso denegado.',
    });
  });

  test('Prueba Negativa: GET /api/pedidos/historial-pedidos - Debe devolver lista vacía si no hay pedidos', async () => {
    const userId = 1;
    const mockToken = jwt.sign({ id: userId, nombre: 'Test User', rol: 'user' }, SECRET_KEY, {
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