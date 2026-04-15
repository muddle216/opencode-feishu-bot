jest.mock('@opencode-ai/sdk/client');
jest.mock('axios');

const request = require('supertest');
const axios = require('axios');
const { createOpencodeClient } = require('@opencode-ai/sdk/client');

process.env.FEISHU_APP_ID = 'test_app_id';
process.env.FEISHU_APP_SECRET = 'test_app_secret';
process.env.FEISHU_VERIFICATION_TOKEN = 'test_token';
process.env.OPENCODE_API_URL = 'http://localhost:4096';
process.env.OPENCODE_API_TOKEN = 'test_token';

let app;
let server;

beforeAll(async () => {
  axios.post.mockResolvedValue({ data: { app_access_token: 'test_token' } });
  createOpencodeClient.mockReturnValue({
    session: {
      list: jest.fn().mockResolvedValue({ data: [] }),
      create: jest.fn().mockResolvedValue({ data: { id: 'test_session' } }),
      get: jest.fn().mockResolvedValue({ data: { id: 'test_session' } }),
      delete: jest.fn().mockResolvedValue({}),
      abort: jest.fn().mockResolvedValue({}),
      fork: jest.fn().mockResolvedValue({ data: { id: 'forked_session' } }),
      prompt: jest.fn().mockResolvedValue({ data: { info: { parts: [] } } }),
    },
  });

  app = require('../server.js');
  
  await new Promise(resolve => setTimeout(resolve, 200));
  
  if (app && app.close) {
    server = app;
  }
});

afterAll(() => {
  if (server && server.close) {
    server.close();
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  axios.post.mockResolvedValue({ data: { app_access_token: 'test_token' } });
});

describe('Health Endpoint', () => {
  test('GET /health returns ok status', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body).toHaveProperty('timestamp');
    expect(res.body).toHaveProperty('uptime');
  });
});

describe('Test Endpoints', () => {
  test('GET /test returns test info', async () => {
    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('testId');
    expect(res.body.message).toBe('Test endpoint active');
    expect(res.body.endpoints).toHaveProperty('testListSessions');
  });

  test('GET /test/sessions returns session list', async () => {
    const mockList = createOpencodeClient().session.list;
    mockList.mockResolvedValue({ data: [{ id: 'session_1', title: 'Test Session' }] });
    const res = await request(app).get('/test/sessions');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.sessions).toHaveLength(1);
  });

  test('GET /test/sessions handles error', async () => {
    const mockList = createOpencodeClient().session.list;
    mockList.mockRejectedValue(new Error('API Error'));
    const res = await request(app).get('/test/sessions');
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('API Error');
  });

  test('POST /test/sessions creates session', async () => {
    const res = await request(app).post('/test/sessions').send({ title: 'New Session' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.session.id).toBe('test_session');
  });

  test('GET /test/sessions/:id returns session', async () => {
    const res = await request(app).get('/test/sessions/session_1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('POST /test/sessions/:id/message sends message', async () => {
    const res = await request(app)
      .post('/test/sessions/session_1/message')
      .send({ message: 'Hello' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('POST /test/sessions/:id/message requires message', async () => {
    const res = await request(app)
      .post('/test/sessions/session_1/message')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Message is required');
  });

  test('DELETE /test/sessions/:id deletes session', async () => {
    const res = await request(app).delete('/test/sessions/session_1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('POST /test/simulate-error handles error simulation', async () => {
    const res = await request(app).post('/test/simulate-error').send({ type: 'api' });
    expect(res.status).toBe(401);
  });
});

describe('Webhook Endpoint', () => {
  test('POST /webhook/feishu handles url_verification', async () => {
    const res = await request(app)
      .post('/webhook/feishu')
      .send({ type: 'url_verification', challenge: 'test_challenge', token: 'test_token' });
    expect(res.status).toBe(200);
    expect(res.body.challenge).toBe('test_challenge');
  });

  test('POST /webhook/feishu rejects invalid token', async () => {
    const res = await request(app)
      .post('/webhook/feishu')
      .send({ type: 'url_verification', challenge: 'test', token: 'wrong_token' });
    expect(res.status).toBe(403);
  });

  test('POST /webhook/feishu handles v2 message event', async () => {
    const res = await request(app)
      .post('/webhook/feishu')
      .send({
        schema: '2.0',
        header: { event_type: 'im.message.receive_v1' },
        event: {
          message: {
            message_type: 'text',
            content: JSON.stringify({ text: '/help' }),
            chat_id: 'test_chat',
          },
          sender: { sender_id: { open_id: 'test_user' } },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
  });

  test('POST /webhook/feishu handles card action', async () => {
    const res = await request(app)
      .post('/webhook/feishu')
      .send({
        schema: '2.0',
        header: { event_type: 'card.action.trigger' },
        event: {
          action: { value: '{"type":"show_help"}' },
          context: { open_chat_id: 'test_chat' },
          operator: { open_id: 'test_user' },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
  });

  test('POST /webhook/feishu handles event_callback', async () => {
    const res = await request(app)
      .post('/webhook/feishu')
      .send({
        type: 'event_callback',
        event: {
          event_type: 'message',
          open_chat_id: 'test_chat',
          open_id: 'test_user',
          message: {
            message_type: 'text',
            content: JSON.stringify({ text: '/help' }),
          },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
  });

  test('POST /webhook/feishu returns 400 for unknown type', async () => {
    const res = await request(app)
      .post('/webhook/feishu')
      .send({ type: 'unknown' });
    expect(res.status).toBe(400);
  });
});

describe('SDK Client Initialization', () => {
  test('SDK createOpencodeClient was called with correct config', () => {
    expect(createOpencodeClient).toHaveBeenCalledWith({
      baseUrl: 'http://localhost:4096',
      apiKey: 'test_token',
    });
  });
});
