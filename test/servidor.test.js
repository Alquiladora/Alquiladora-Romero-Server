const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const { mockDeep } = require('jest-mock-extended');
const routerPedidos = require('../consultas/clsPedidos');
const { pool } = require('../connectBd'); 
const SECRET_KEY = process.env.JWT_SECRET || 'your-secret-key'; 


jest.mock('../connectBd', () => ({
  pool: mockDeep(),
}));

jest.mock('../consultas/clsUsuarios', () => ({
  verifyToken: jest.fn(),
  obtenerFechaMexico: jest.fn(() => '2025-10-27 10:59:00'),
}));

describe('Integration Tests: API de Pedidos (/api/pedidos/historial-pedidos)', () => {
  let app;
  let mockPool;

 
  beforeAll(() => {

    app = express();
    app.use(express.json());
    app.use('/api/pedidos', routerPedidos);


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


  afterAll(() => {
    jest.resetAllMocks();
  });


  test('Prueba Negativa: GET /api/pedidos/historial-pedidos - Debe rechazar el acceso sin token', async () => {
    const res = await request(app)
      .get('/api/pedidos/historial-pedidos')
      .send();

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      message: 'Token no proporcionado. Acceso denegado.',
    });
  });

  test('Prueba Negativa: GET /api/pedidos/historial-pedidos - Debe rechazar con token inválido', async () => {
    require('../consultas/clsUsuarios').verifyToken.mockImplementation((req, res, next) => {
      return res.status(401).json({ message: 'El token ha expirado. Inicia sesión nuevamente.' });
    });

    const res = await request(app)
      .get('/api/pedidos/historial-pedidos')
      .set('Authorization', 'Bearer invalid-token')
      .send();

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({
      message: 'El token ha expirado. Inicia sesión nuevamente.',
    });
  });


  test('Prueba Positiva: GET /api/pedidos/historial-pedidos - Debe devolver pedidos con un token válido', async () => {
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
      .set('Authorization', `Bearer ${mockToken}`)
      .send();

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
      .set('Authorization', `Bearer ${mockToken}`)
      .send();

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

 
  test('Prueba Negativa: GET /api/pedidos/historial-pedidos - Debe manejar errores de base de datos', async () => {
    const userId = 1;
    const mockToken = jwt.sign({ id: userId, nombre: 'Test User', rol: 'user' }, SECRET_KEY, {
      expiresIn: '24h',
    });


    require('../consultas/clsUsuarios').verifyToken.mockImplementation((req, res, next) => {
      req.user = { id: userId, nombre: 'Test User', rol: 'user' };
      next();
    });

 
    mockPool.getConnection.mockRejectedValueOnce(new Error('Database connection failed'));

    const res = await request(app)
      .get('/api/pedidos/historial-pedidos?pagina=1&limite=10')
      .set('Authorization', `Bearer ${mockToken}`)
      .send();

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      success: false,
      error: 'Error interno del servidor.',
    });
  });
});