#!/usr/bin/env node

const express = require('express');
const bodyParser = require('body-parser');
const winston = require('winston');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config();

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'opencode-feishu-bot' },
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
  ],
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    ),
  }));
}

const config = {
  feishuAppId: process.env.FEISHU_APP_ID || '',
  feishuAppSecret: process.env.FEISHU_APP_SECRET || '',
  feishuVerificationToken: process.env.FEISHU_VERIFICATION_TOKEN || '',
  opencodeApiUrl: process.env.OPENCODE_API_URL || 'http://localhost:4096',
  opencodeApiToken: process.env.OPENCODE_API_TOKEN || '',
  port: process.env.PORT || 3000,
  host: process.env.HOST || '0.0.0.0',
  sessionTimeout: process.env.SESSION_TIMEOUT || 3600000,
  maxSessionsPerUser: process.env.MAX_SESSIONS_PER_USER || 5,
};

if (!config.feishuAppId || !config.feishuAppSecret || !config.feishuVerificationToken) {
  logger.error('Missing Feishu bot configuration');
  process.exit(1);
}

if (!config.opencodeApiUrl || !config.opencodeApiToken) {
  logger.error('Missing OpenCode API configuration');
  process.exit(1);
}

const app = express();
let opencodeClient;

app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

async function initOpenCodeClient() {
  try {
    const { createOpencodeClient } = await import('@opencode-ai/sdk/client');
    opencodeClient = createOpencodeClient({
      baseUrl: config.opencodeApiUrl,
      apiKey: config.opencodeApiToken,
    });
    logger.info('OpenCode SDK client initialized');
  } catch (err) {
    logger.error('Failed to initialize OpenCode SDK:', err.message);
    process.exit(1);
  }
}

class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.userSessions = new Map();
    this.sessionHistory = new Map();
    this.cleanupInterval = setInterval(() => this.cleanupExpiredSessions(), 60000);
  }

  createLocalSession(userId, chatId, description = '') {
    const sessionId = `local_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const session = {
      id: sessionId,
      userId,
      chatId,
      description,
      createdAt: new Date(),
      lastActivity: new Date(),
      status: 'created',
      logs: [],
      currentCommand: null,
      externalId: null,
    };
    this.sessions.set(sessionId, session);
    if (!this.userSessions.has(userId)) {
      this.userSessions.set(userId, []);
    }
    this.userSessions.get(userId).push(sessionId);
    const userSessionList = this.userSessions.get(userId);
    if (userSessionList.length > config.maxSessionsPerUser) {
      const oldestSession = userSessionList.shift();
      this.sessions.delete(oldestSession);
      this.sessionHistory.delete(oldestSession);
    }
    logger.info(`Created local session: ${sessionId}`, { userId, chatId });
    return session;
  }

  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = new Date();
    }
    return session;
  }

  getUserSessions(userId) {
    const sessionIds = this.userSessions.get(userId) || [];
    return sessionIds.map(id => this.sessions.get(id)).filter(Boolean);
  }

  updateSessionStatus(sessionId, status) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = status;
      session.lastActivity = new Date();
    }
  }

  addSessionLog(sessionId, log) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.logs.push({
        timestamp: new Date(),
        content: log,
      });
      if (session.logs.length > 1000) {
        session.logs = session.logs.slice(-1000);
      }
      session.lastActivity = new Date();
    }
  }

  setCurrentCommand(sessionId, command) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.currentCommand = command;
      session.lastActivity = new Date();
    }
  }

  cleanupExpiredSessions() {
    const now = new Date();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.lastActivity > config.sessionTimeout) {
        this.endSession(sessionId);
      }
    }
  }

  endSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessionHistory.set(sessionId, {
        ...session,
        endedAt: new Date(),
        status: 'ended',
      });
      this.sessions.delete(sessionId);
      const userSessionList = this.userSessions.get(session.userId);
      if (userSessionList) {
        const index = userSessionList.indexOf(sessionId);
        if (index > -1) {
          userSessionList.splice(index, 1);
        }
      }
      logger.info(`Session ended: ${sessionId}`);
    }
  }

  deleteSession(sessionId) {
    const session = this.sessions.get(sessionId) || this.sessionHistory.get(sessionId);
    if (session) {
      this.sessions.delete(sessionId);
      this.sessionHistory.delete(sessionId);
      const userSessionList = this.userSessions.get(session.userId);
      if (userSessionList) {
        const index = userSessionList.indexOf(sessionId);
        if (index > -1) {
          userSessionList.splice(index, 1);
        }
      }
      logger.info(`Session deleted: ${sessionId}`);
    }
  }
}

const sessionManager = new SessionManager();

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    uptime: process.uptime(),
  });
});

app.get('/', (req, res) => {
  res.send(`
    <h1>OpenCode Feishu Bot</h1>
    <p>Health check: <a href="/health">/health</a></p>
    <p>Test endpoint: <a href="/test">/test</a></p>
  `);
});

const processedEvents = new Set();
const MAX_PROCESSED_EVENTS = 1000;

app.post('/webhook/feishu', async (req, res) => {
  try {
    const { type, challenge, schema, header, event } = req.body;

    if (schema === '2.0' && header?.event_id) {
      if (processedEvents.has(header.event_id)) {
        logger.info(`Duplicate event ignored: ${header.event_id}`);
        return res.json({ status: 'success', duplicate: true });
      }
      processedEvents.add(header.event_id);
      if (processedEvents.size > MAX_PROCESSED_EVENTS) {
        const firstKey = processedEvents.values().next().value;
        processedEvents.delete(firstKey);
      }
    }

    logger.info(`Received Feishu request: ${JSON.stringify(req.body, null, 2)}`);

    if (type === 'url_verification') {
      const { token } = req.body;
      if (token === config.feishuVerificationToken) {
        return res.json({ challenge });
      } else {
        return res.status(403).json({ error: 'Verification failed' });
      }
    }

    if (schema === '2.0' && header && event) {
      const eventType = header.event_type;
      if (eventType === 'im.message.receive_v1') {
        const messageData = { ...event };
        res.json({ status: 'success' });
        process.nextTick(() => handleFeishuMessageV2(messageData).catch(err => logger.error('Async message error:', err)));
      } else if (eventType === 'card.action.trigger') {
        const { action, operator, context } = event;
        logger.info(`Card action: value type=${typeof action?.value}, value=${JSON.stringify(action?.value)}`);
        if (action && action.value) {
          const chatId = context?.open_chat_id;
          const userId = operator?.open_id;
          logger.info(`Card action context: chatId=${chatId}, userId=${userId}`);
          if (chatId && userId) {
            res.json({ status: 'success' });
            process.nextTick(() => handleFeishuAction('button_click', action.value, chatId, userId).catch(err => logger.error('Async action error:', err)));
            return;
          }
        }
        res.json({ status: 'success' });
      } else {
        res.json({ status: 'success' });
      }
      return;
    }

    if (type === 'event_callback') {
      const { event } = req.body;
      res.json({ status: 'success' });
      process.nextTick(() => handleFeishuEvent(event).catch(err => logger.error('Async event error:', err)));
      return;
    }

    res.status(400).json({ error: 'Unknown request type' });
  } catch (error) {
    logger.error('Feishu webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function handleFeishuMessageV2(event) {
  const { message, sender } = event;
  if (!message) {
    logger.warn('No message field in event');
    return;
  }
  const { content, message_type, chat_id } = message;
  const openId = sender?.sender_id?.open_id;
  if (message_type === 'text') {
    try {
      const contentObj = JSON.parse(content);
      const text = contentObj.text || '';
      await handleFeishuMessage(text, chat_id, openId);
    } catch (e) {
      logger.error('Failed to parse message content:', e);
    }
  }
}

async function handleFeishuEvent(event) {
  const { event_type, open_chat_id, open_id, message, action } = event;
  if (event_type === 'message' && message) {
    const { content, message_type } = message;
    if (message_type === 'text') {
      const textContent = JSON.parse(content).text;
      await handleFeishuMessage(textContent, open_chat_id, open_id);
    }
  } else if (event_type === 'interactive_message' && action) {
    const { action_type, value } = action;
    const { user_id, open_chat_id } = event;
    await handleFeishuAction(action_type, value, open_chat_id, user_id);
  }
}

async function handleFeishuMessage(text, chatId, userId) {
  const command = text.trim();
  try {
    if (command === '/help' || command === '/opencode' || command === '/opencode help' || command === '/opencode 帮助') {
      await sendFeishuHelp(chatId);
    } else if (command === '/list' || command === '/opencode list' || command === '/opencode ls' || command === '/opencode 列表') {
      await sendFeishuSessionList(chatId, userId);
    } else if (command.startsWith('/create ') || command.startsWith('/opencode create') || command.startsWith('/opencode new') || command.startsWith('/opencode 创建')) {
      const description = text.replace(/^\/(opencode\s+)?(create|new|创建)\s*/i, '').trim();
      await createFeishuSession(chatId, userId, description);
    } else if (command.startsWith('/attach ') || command.startsWith('/opencode attach') || command.startsWith('/opencode enter') || command.startsWith('/opencode 进入')) {
      const sessionId = text.replace(/^\/(opencode\s+)?(attach|enter|进入)\s*/i, '').trim();
      await attachFeishuSession(chatId, userId, sessionId);
    } else if (command === '/status' || command === '/opencode status' || command === '/opencode stat' || command === '/opencode 状态') {
      await sendFeishuStatus(chatId);
    } else if (command.startsWith('/opencode')) {
      await sendFeishuUnknownCommand(chatId, command);
    } else {
      const activeSession = sessionManager.getUserSessions(userId).find(s => s.status === 'active' && s.chatId === chatId);
      if (activeSession) {
        await executeSessionCommand(activeSession, command, chatId);
      } else {
        await sendFeishuHelp(chatId);
      }
    }
  } catch (error) {
    logger.error('Handle message error:', error);
    await sendFeishuError(chatId, error.message);
  }
}

async function executeSessionCommand(session, command, chatId) {
  try {
    sessionManager.setCurrentCommand(session.id, command);
    sessionManager.addSessionLog(session.id, `> ${command}`);
    let result;

    if (command === ':exit' || command === '：exit' || command === ':quit' || command === '：quit' || command === ':bye' || command === '：bye') {
      result = 'Session ended';
      sessionManager.updateSessionStatus(session.id, 'ended');
      await sendFeishuSessionEnded(chatId, session.id);
      return;
    } else if (command === ':help' || command === '：help' || command === ':h' || command === '：h') {
      result = `Session commands (prefix with : or ：):
- :help/:h - Show this help
- :exit/:quit/:bye - Exit session
- :clear - Clear screen
- :logs - View session logs
- :status - View session status
- :history [n] - View last n messages (default 10)
- :history user/q - Show only user requests
- :history assistant/r - Show only assistant responses
- :interrupt - Interrupt current operation
- :compact - Compact session history
- :share - Get share URL
- :agent.cycle - Cycle to next agent`;
      await sendFeishuCommandResult(chatId, session.id, command, result);
    } else if (command === ':clear' || command === '：clear') {
      result = 'Screen cleared';
      await sendFeishuClearScreen(chatId, session.id);
      return;
    } else if (command === ':logs' || command === '：logs') {
      const logs = session.logs.slice(-20).map(log => `${log.timestamp.toLocaleTimeString()}: ${log.content}`).join('\n');
      result = `Session logs:\n${logs}`;
      await sendFeishuCommandResult(chatId, session.id, command, result);
    } else if (command === ':status' || command === '：status') {
      const displayId = session.externalId || session.id;
      result = `Session status:
- ID: ${displayId}
- Created: ${session.createdAt.toLocaleString()}
- Last activity: ${session.lastActivity.toLocaleString()}
- Status: ${session.status}
- Commands: ${session.logs.filter(l => l.content.startsWith('>')).length}`;
      await sendFeishuCommandResult(chatId, session.id, command, result);
    } else if (command === ':interrupt' || command === '：interrupt') {
      if (!session.externalId) {
        result = 'Error: No active session';
      } else {
        try {
          await opencodeClient.session.abort({ path: { id: session.externalId } });
          result = 'Session interrupted';
        } catch (e) {
          result = `Interrupt failed: ${e.message}`;
        }
        await sendFeishuCommandResult(chatId, session.id, command, result);
      }
    } else if (command === ':compact' || command === '：compact') {
      if (!session.externalId) {
        result = 'Error: No active session';
      } else {
        try {
          await opencodeClient.session.init({ path: { id: session.externalId } });
          result = 'Session compacted';
        } catch (e) {
          result = `Compact failed: ${e.message}`;
        }
        await sendFeishuCommandResult(chatId, session.id, command, result);
      }
    } else if (command === ':share' || command === '：share') {
      if (!session.externalId) {
        result = 'Error: No active session';
      } else {
        try {
          const shareResp = await opencodeClient.session.share({ path: { id: session.externalId } });
          const shareUrl = shareResp.data?.url || 'Share URL not available';
          result = `Share URL: ${shareUrl}`;
        } catch (e) {
          result = `Share failed: ${e.message}`;
        }
        await sendFeishuCommandResult(chatId, session.id, command, result);
      }
    } else if (command.startsWith(':history') || command.startsWith('：history') || command.startsWith(':msgs') || command.startsWith('：msgs')) {
      if (!session.externalId) {
        result = 'Error: No active session';
      } else {
        try {
          const parts = command.split(' ');
          const filterArg = parts[1]?.toLowerCase();
          const msgCount = parseInt(parts[parts.length - 1]) || 10;
          
          const msgResp = await opencodeClient.session.messages({
            path: { id: session.externalId },
            query: { limit: Math.min(msgCount * 2, 100) }
          });
          logger.info(`Messages response: ${JSON.stringify(msgResp.data).substring(0, 2000)}`);
          let messages = msgResp.data || [];
          
          // 根据 filter 过滤消息
          if (filterArg === 'user' || filterArg === 'u' || filterArg === 'q' || filterArg === '请求') {
            messages = messages.filter(m => m.info.role === 'user');
          } else if (filterArg === 'assistant' || filterArg === 'a' || filterArg === 'r' || filterArg === '回复') {
            messages = messages.filter(m => m.info.role === 'assistant');
          }
          
          // 反转顺序，最新的在前
          messages = messages.reverse();
          
          if (messages.length === 0) {
            result = 'No messages in session';
          } else {
            const lines = [];
            for (const msg of messages) {
              const info = msg.info || msg;
              const role = info.role === 'user' ? '👤' : '🤖';
              const time = info.time?.created ? new Date(info.time.created).toLocaleTimeString() : '';
              const agent = info.agent || info.mode || 'unknown';
              const msgParts = msg.parts || [];

              // 提取text类型的内容
              const textContent = msgParts
                .filter(p => p.type === 'text' && p.text)
                .map(p => p.text)
                .join('\n')
                .substring(0, 500);

              if (textContent) {
                lines.push(`${role} [${time}] ${agent}\n  ${textContent}`);
              } else {
                const reasoning = msgParts.find(p => p.type === 'reasoning');
                if (reasoning && reasoning.text) {
                  const shortText = reasoning.text.substring(0, 200);
                  lines.push(`${role} [${time}] ${agent}\n  [:reasoning] ${shortText}...`);
                } else {
                  lines.push(`${role} [${time}] ${agent}`);
                }
              }
            }

            let title = `Last ${messages.length} messages:`;
            if (filterArg === 'user' || filterArg === 'u' || filterArg === 'q' || filterArg === '请求') {
              title = `Last ${messages.length} user requests:`;
            } else if (filterArg === 'assistant' || filterArg === 'a' || filterArg === 'r' || filterArg === '回复') {
              title = `Last ${messages.length} assistant responses:`;
            }
            result = `${title}\n${lines.join('\n\n')}`;
          }
        } catch (e) {
          result = `History failed: ${e.message}`;
        }
        logger.info(`:history command result built`, { resultLength: result?.length, resultPreview: result?.substring(0, 200) });
        await sendFeishuCommandResult(chatId, session.id, command, result);
      }
    } else if (command === ':agent.cycle' || command === '：agent.cycle') {
      if (!session.externalId) {
        result = 'Error: No active session';
      } else {
        try {
          await opencodeClient.session.command({
            path: { id: session.externalId },
            body: { command: 'agent.cycle' }
          });
          result = 'Agent cycled to next';
        } catch (e) {
          result = `Agent cycle failed: ${e.message}`;
        }
        await sendFeishuCommandResult(chatId, session.id, command, result);
      }
    } else {
      if (!session.externalId) {
        await sendFeishuError(chatId, 'Error: No valid OpenCode session. Use /attach to connect to an existing session or /create to create a new one.');
        return;
      }
      logger.info(`Executing OpenCode command: session=${session.id}, externalId=${session.externalId}, command=${command}`);
      
      try {
        await sendFeishuStreamingStart(chatId, session.id, command);
        result = await executeOpenCodeCommandWithStreaming(session, chatId, command);
        
        sessionManager.addSessionLog(session.id, result);
        await sendFeishuCommandResult(chatId, session.id, command, result);
      } catch (error) {
        const errorMsg = `Command failed: ${error.message}`;
        sessionManager.addSessionLog(session.id, errorMsg);
        await sendFeishuCommandError(chatId, session.id, command, errorMsg);
      }
      return;
    }
  } catch (error) {
    const errorMsg = `Command failed: ${error.message}`;
    sessionManager.addSessionLog(session.id, errorMsg);
    await sendFeishuCommandError(chatId, session.id, command, errorMsg);
  }
}

async function executeOpenCodeCommandWithStreaming(session, chatId, command) {
  const externalSessionId = session.externalId;
  logger.info(`Streaming command: session=${externalSessionId}, command=${command}`);
  
  const responseParts = [];
  let lastUpdateTime = Date.now();
  const UPDATE_INTERVAL = 2000;
  
  try {
    const sseResult = await opencodeClient.client.sse.post({
      url: `/session/${externalSessionId}/message`,
      body: {
        parts: [{ type: "text", text: command }],
      },
      headers: {
        "Content-Type": "application/json",
      },
    });
    
    logger.info('SSE stream started');
    
    for await (const eventData of sseResult.stream) {
      const now = Date.now();
      logger.info(`SSE event received: ${JSON.stringify(eventData).substring(0, 200)}`);
      
      const event = eventData;
      if (!event) continue;
      
      let textAdded = false;
      
      if (event.part) {
        const part = event.part;
        if (part.type === 'text' && part.text) {
          responseParts.push(part.text);
          textAdded = true;
          logger.info(`Text part: ${part.text.substring(0, 100)}`);
        } else if (part.type === 'reasoning' && part.text) {
          const thinkingText = `[:thinking ${part.text.substring(0, 300)}...]`;
          responseParts.push(thinkingText);
          await sendFeishuStreamingUpdate(chatId, session.id, part.text.substring(0, 500), true);
          lastUpdateTime = now;
        } else if (part.type === 'tool') {
          const state = part.state || {};
          if (state.status === 'pending') {
            responseParts.push(`[:tool ${part.tool} - pending]`);
          } else if (state.status === 'running') {
            responseParts.push(`[:tool ${part.tool} - running]`);
          } else if (state.status === 'completed') {
            const output = state.output?.substring(0, 200) || '';
            responseParts.push(`[:tool ${part.tool} - completed] ${output}`);
          } else if (state.status === 'error') {
            responseParts.push(`[:tool ${part.tool} - error: ${state.error}]`);
          }
        } else if (part.type === 'agent' && part.name) {
          responseParts.push(`[:agent ${part.name}]`);
        } else if (part.type === 'step-start') {
          responseParts.push(`[:step ${part.snapshot?.substring(0, 100) || ''}]`);
        } else if (part.type === 'step-finish') {
          const reason = part.reason || 'completed';
          responseParts.push(`[:step ${reason}]`);
        }
      } else if (event.info && event.parts) {
        for (const part of event.parts) {
          if (part.type === 'text' && part.text) {
            responseParts.push(part.text);
            textAdded = true;
          }
        }
      } else if (event.permission) {
        const permission = event.permission;
        logger.info(`Permission request: ${permission.id} - ${permission.title}`);
        await sendPermissionRequest(chatId, session.id, permission);
        responseParts.push(`[:permission ${permission.title}]`);
      } else if (event.status) {
        logger.info(`Session status: ${event.status}`);
      } else if (event.content || event.text || event.message) {
        const text = event.content || event.text || event.message || '';
        if (text) {
          responseParts.push(text);
          textAdded = true;
        }
      } else if (event.subagent) {
        responseParts.push(`[:subagent ${event.subagent}]`);
      } else if (event.thinking) {
        const thinkingText = String(event.thinking).substring(0, 500);
        responseParts.push(`[:thinking ${thinkingText}...]`);
      }
      
      if (textAdded && now - lastUpdateTime > UPDATE_INTERVAL) {
        const currentOutput = responseParts.join('\n');
        await sendFeishuStreamingUpdate(chatId, session.id, currentOutput.substring(currentOutput.length - 1000));
        lastUpdateTime = now;
      }
    }
    
    logger.info('SSE stream ended');
    
  } catch (sseError) {
    logger.error(`Streaming error: ${sseError.message}`);
    const promptResult = await executeOpenCodeCommandPrompt(session, chatId, command);
    return promptResult;
  }
  
  logger.info(`SSE responseParts count: ${responseParts.length}`);
  if (responseParts.length > 0) {
    const result = responseParts.join('\n');
    logger.info(`SSE response: ${result.substring(0, 500)}`);
    return result;
  }
  
  return 'Command executed. No response content.';
}

async function executeOpenCodeCommandPrompt(session, chatId, command) {
  const externalSessionId = session.externalId;
  
  try {
    const response = await opencodeClient.session.prompt({
      path: { id: externalSessionId },
      body: {
        parts: [{ type: "text", text: command }],
      },
    });
    
    if (response && response.data) {
      const { info, parts } = response.data;
      logger.info(`OpenCode response: info=${JSON.stringify(info)?.substring(0, 200)}, parts count=${parts?.length}`);
      
      const responseParts = [];
      for (const part of parts || []) {
        if (part.type === 'text') {
          responseParts.push(part.text || '');
        } else if (part.type === 'reasoning') {
          responseParts.push(`[Reasoning: ${(part.text || '').substring(0, 300)}...]`);
        } else if (part.type === 'tool') {
          const state = part.state;
          if (state.status === 'completed') {
            const output = state.output?.substring(0, 200) || '';
            responseParts.push(`[:tool ${part.tool} completed] ${output}`);
          } else if (state.status === 'error') {
            responseParts.push(`[:tool ${part.tool} error: ${state.error}]`);
          } else if (state.status === 'running') {
            responseParts.push(`[:tool ${part.tool} running...]`);
          } else {
            responseParts.push(`[:tool ${part.tool} pending]`);
          }
        } else if (part.type === 'agent' && part.name) {
          responseParts.push(`[:agent ${part.name}]`);
        } else if (part.type === 'step-finish') {
          responseParts.push(`[:step ${part.reason || 'completed'}]`);
        } else if (part.type === 'file') {
          responseParts.push(`[:file ${part.filename || part.url}]`);
        } else if (part.type === 'snapshot') {
          responseParts.push(`[:snapshot ${(part.snapshot || '').substring(0, 100)}...]`);
        }
      }
      
      const responseText = responseParts.join('\n');
      if (responseText) {
        return responseText;
      }
      
      if (info && info.error) {
        return `Error: ${info.error}`;
      }
    }
    
    return 'Command executed. No response content.';
  } catch (error) {
    logger.error('OpenCode API error:', error.message);
    
    if (error.response) {
      const status = error.response.status;
      if (status === 404) {
        return 'Error: Session not found. Please create a new session.';
      }
      if (status === 401 || status === 403) {
        return 'Error: Authentication failed. Check your API token.';
      }
    }
    
    throw error;
  }
}

async function handleFeishuAction(actionType, value, chatId, userId) {
  let actionData;
  logger.info(`handleFeishuAction: typeof value=${typeof value}, value=${JSON.stringify(value).substring(0, 200)}`);
  
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'object' && parsed !== null) {
        actionData = parsed;
      } else if (typeof parsed === 'string') {
        const doubleParsed = JSON.parse(parsed);
        actionData = doubleParsed;
      } else {
        logger.error(`Parsed value is not an object: ${typeof parsed}`);
        await sendFeishuError(chatId, 'Invalid action data');
        return;
      }
    } catch (e) {
      logger.error(`Action parse error: ${e.message}, raw: ${value}`);
      await sendFeishuError(chatId, 'Invalid action data');
      return;
    }
  } else if (typeof value === 'object' && value !== null) {
    actionData = value;
  } else {
    logger.error(`Invalid action value type: ${typeof value}`);
    await sendFeishuError(chatId, 'Invalid action data');
    return;
  }
  
  logger.info(`Parsed actionData: ${JSON.stringify(actionData)}`);

  if (!actionData || typeof actionData !== 'object') {
    await sendFeishuError(chatId, 'Invalid action data');
    return;
  }

  switch (actionData.type) {
    case 'attach_session':
      await attachFeishuSession(chatId, userId, actionData.sessionId);
      break;
    case 'stop_session':
      await stopFeishuSession(chatId, userId, actionData.sessionId);
      break;
    case 'delete_session':
      await deleteFeishuSession(chatId, userId, actionData.sessionId);
      break;
    case 'restart_session':
      await restartFeishuSession(chatId, userId, actionData.sessionId);
      break;
    case 'view_logs':
      await sendFeishuSessionLogs(chatId, userId, actionData.sessionId);
      break;
    case 'list_sessions':
      await sendFeishuSessionList(chatId, userId);
      break;
    case 'show_help':
      await sendFeishuHelp(chatId);
      break;
    case 'create_session':
      await createFeishuSession(chatId, userId, '');
      break;
    case 'permission_approve':
      await handlePermissionResponse(chatId, userId, actionData.permissionId, actionData.sessionId, true);
      break;
    case 'permission_deny':
      await handlePermissionResponse(chatId, userId, actionData.permissionId, actionData.sessionId, false);
      break;
    default:
      logger.warn(`Unknown action type: ${actionData.type}`);
  }
}

async function handlePermissionResponse(chatId, userId, permissionId, sessionId, approved) {
  try {
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      await sendFeishuError(chatId, 'Session not found');
      return;
    }
    if (session.userId !== userId) {
      await sendFeishuError(chatId, 'Access denied');
      return;
    }
    
    if (!session.externalId) {
      await sendFeishuError(chatId, 'No active session');
      return;
    }
    
    logger.info(`Permission ${permissionId} ${approved ? 'approved' : 'denied'} for session ${session.externalId}`);
    
    // Send permission reply via SDK using postSessionIdPermissionsPermissionId
    await opencodeClient.postSessionIdPermissionsPermissionId({
      path: { 
        id: session.externalId,
        permissionID: permissionId,
      },
      body: { approve: approved },
    });
    
    await sendFeishuCard(chatId, {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: approved ? 'Permission Approved' : 'Permission Denied' },
        template: approved ? 'green' : 'red',
      },
      elements: [
        { tag: 'div', text: { tag: 'plain_text', content: `Permission request ${permissionId.substring(0, 20)}... has been ${approved ? 'approved' : 'denied'}.` } },
      ],
    });
  } catch (error) {
    logger.error('Permission response error:', error);
    await sendFeishuError(chatId, `Failed to respond to permission: ${error.message}`);
  }
}

async function sendPermissionRequest(chatId, sessionId, permission) {
  const permissionId = permission.id || 'unknown';
  const title = permission.title || 'Permission Request';
  const description = permission.description || 'A permission is required to continue.';
  
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `🔐 ${title}` },
      template: 'orange',
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**${description}**` } },
      { tag: 'div', text: { tag: 'plain_text', content: `Permission ID: ${permissionId.substring(0, 30)}...` } },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '✅ Approve' }, type: 'primary', value: JSON.stringify({ type: 'permission_approve', permissionId, sessionId }) },
        { tag: 'button', text: { tag: 'plain_text', content: '❌ Deny' }, type: 'danger', value: JSON.stringify({ type: 'permission_deny', permissionId, sessionId }) },
      ]},
    ],
  };
  await sendFeishuCard(chatId, card);
}

async function stopFeishuSession(chatId, userId, sessionId) {
  try {
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      await sendFeishuSessionNotFound(chatId, sessionId);
      return;
    }
    if (session.userId !== userId) {
      await sendFeishuSessionAccessDenied(chatId, sessionId);
      return;
    }
    if (session.externalId) {
      try {
        await opencodeClient.session.abort({
          path: { id: session.externalId },
        });
      } catch (e) {
        logger.warn('Failed to abort remote session:', e.message);
      }
    }
    sessionManager.updateSessionStatus(sessionId, 'ended');
    await sendFeishuSessionEnded(chatId, sessionId);
  } catch (error) {
    logger.error('Stop session error:', error);
    await sendFeishuError(chatId, error.message);
  }
}

async function deleteFeishuSession(chatId, userId, sessionId) {
  try {
    const session = sessionManager.getSession(sessionId) || sessionManager.sessionHistory.get(sessionId);
    if (!session) {
      await sendFeishuSessionNotFound(chatId, sessionId);
      return;
    }
    if (session.userId !== userId) {
      await sendFeishuSessionAccessDenied(chatId, sessionId);
      return;
    }
    if (session.externalId) {
      try {
        await opencodeClient.session.delete({
          path: { id: session.externalId },
        });
      } catch (e) {
        logger.warn('Failed to delete remote session:', e.message);
      }
    }
    sessionManager.deleteSession(sessionId);
    await sendFeishuCard(chatId, {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: 'Session Deleted' },
        template: 'green',
      },
      elements: [
        { tag: 'div', text: { tag: 'plain_text', content: `Session ${sessionId} has been deleted.` } },
      ],
    });
  } catch (error) {
    logger.error('Delete session error:', error);
    await sendFeishuError(chatId, error.message);
  }
}

async function restartFeishuSession(chatId, userId, sessionId) {
  try {
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      await sendFeishuSessionNotFound(chatId, sessionId);
      return;
    }
    if (session.userId !== userId) {
      await sendFeishuSessionAccessDenied(chatId, sessionId);
      return;
    }
    if (!session.externalId) {
      await sendFeishuError(chatId, 'Cannot restart local session');
      return;
    }
    try {
      const forked = await opencodeClient.session.fork({
        path: { id: session.externalId },
        body: {},
      });
      if (forked.data?.id) {
        session.externalId = forked.data.id;
        sessionManager.updateSessionStatus(sessionId, 'active');
        await sendFeishuCard(chatId, {
          config: { wide_screen_mode: true },
          header: {
            title: { tag: 'plain_text', content: 'Session Restarted' },
            template: 'green',
          },
          elements: [
            { tag: 'div', text: { tag: 'plain_text', content: `Session forked with new ID: ${forked.data.id}` } },
          ],
        });
      }
    } catch (e) {
      logger.error('Fork session error:', e);
      await sendFeishuError(chatId, `Failed to restart session: ${e.message}`);
    }
  } catch (error) {
    logger.error('Restart session error:', error);
    await sendFeishuError(chatId, error.message);
  }
}

async function sendFeishuHelp(chatId) {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'OpenCode Bot Help' },
      template: 'blue',
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: '## Commands\n- `/help` - Show this help\n- `/list` - List sessions\n- `/create [desc]` - Create session\n- `/attach [id]` - Attach to session\n- `/status` - Show system status' } },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: 'List Sessions' }, type: 'primary', value: JSON.stringify({ type: 'list_sessions' }) },
        { tag: 'button', text: { tag: 'plain_text', content: 'Create Session' }, type: 'default', value: JSON.stringify({ type: 'create_session' }) },
      ]},
    ],
  };
  await sendFeishuCard(chatId, card);
}

async function sendFeishuSessionList(chatId, _userId) {
  try {
    const response = await opencodeClient.session.list();
    let sessions = [];
    if (response.data && Array.isArray(response.data)) {
      sessions = response.data;
    }
    // Filter out sub-sessions (they have parentID or title contains "subagent")
    const parentSessions = sessions.filter(s => !s.parentID && !(s.title && s.title.includes('subagent')));
    
    parentSessions.sort((a, b) => {
      const timeA = a.time?.updated || a.time?.created || 0;
      const timeB = b.time?.updated || b.time?.created || 0;
      return timeB - timeA;
    });
    const displaySessions = parentSessions.slice(0, 10);
    const elements = [];
    if (displaySessions.length === 0) {
      elements.push({ tag: 'div', text: { tag: 'plain_text', content: 'No sessions found.' } });
    } else {
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: `Total: **${parentSessions.length}** sessions (${sessions.length - parentSessions.length} sub-sessions hidden)` } });
      for (const session of displaySessions) {
        const lastUpdate = session.time?.updated 
          ? new Date(session.time.updated).toLocaleString() 
          : 'Unknown';
        const title = session.title || session.slug || 'No title';
        const displayId = session.id.length > 20 ? session.id.substring(0, 20) + '...' : session.id;
        
        elements.push(
          { tag: 'div', text: { tag: 'lark_md', content: `**${title}**` } },
          { tag: 'div', text: { tag: 'plain_text', content: `${displayId} · ${lastUpdate}` } },
          { tag: 'action', actions: [
            { tag: 'button', text: { tag: 'plain_text', content: 'Attach' }, type: 'primary', value: JSON.stringify({ type: 'attach_session', sessionId: session.id }) },
          ]},
          { tag: 'div', text: { tag: 'plain_text', content: '---' } }
        );
      }
    }
    elements.push({ tag: 'action', actions: [
      { tag: 'button', text: { tag: 'plain_text', content: 'Create New Session' }, type: 'primary', value: JSON.stringify({ type: 'create_session' }) },
    ]});
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Session List' }, template: 'green' },
      elements,
    };
    await sendFeishuCard(chatId, card);
  } catch (error) {
    logger.error('List sessions error:', error);
    await sendFeishuError(chatId, `Failed to list sessions: ${error.message}`);
  }
}

async function createFeishuSession(chatId, userId, description) {
  try {
    let externalId = null;
    try {
      const response = await opencodeClient.session.create({
        body: { title: description || 'New Session' },
      });
      if (response.data?.id) {
        externalId = response.data.id;
        logger.info(`Created remote session: ${externalId}`);
      } else {
        logger.warn('Remote session created but no ID returned');
      }
    } catch (e) {
      logger.error('Failed to create remote session:', e.message);
    }
    
    if (!externalId) {
      await sendFeishuCard(chatId, {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: 'Session Create Failed' }, template: 'red' },
        elements: [
          { tag: 'div', text: { tag: 'plain_text', content: 'Failed to connect to OpenCode. Please check if OpenCode service is running and try again.' } },
          { tag: 'action', actions: [
            { tag: 'button', text: { tag: 'plain_text', content: 'Retry' }, type: 'primary', value: JSON.stringify({ type: 'create_session' }) },
          ]},
        ],
      });
      return;
    }
    
    const session = sessionManager.createLocalSession(userId, chatId, description);
    session.externalId = externalId;
    sessionManager.updateSessionStatus(session.id, 'active');
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Session Created' }, template: 'green' },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: `**Remote ID:** ${externalId}` } },
        { tag: 'div', text: { tag: 'plain_text', content: description ? `Description: ${description}` : 'No description' } },
        { tag: 'div', text: { tag: 'lark_md', content: '**Session is now active. Send commands to interact.**' } },
      ],
    };
    await sendFeishuCard(chatId, card);
  } catch (error) {
    logger.error('Create session error:', error);
    await sendFeishuError(chatId, error.message);
  }
}

async function attachFeishuSession(chatId, userId, sessionId) {
  logger.info(`attachFeishuSession: chatId=${chatId}, userId=${userId}, sessionId=${sessionId}`);
  try {
    let session = sessionManager.getSession(sessionId);
    logger.info(`getSession result: ${session ? session.id : 'null'}`);
    if (!session) {
      try {
        logger.info(`Fetching remote session: ${sessionId}`);
        const response = await opencodeClient.session.get({ path: { id: sessionId } });
        logger.info(`Remote session response: ${JSON.stringify(response)}`);
        if (response.data) {
          session = sessionManager.createLocalSession(userId, chatId, response.data.title || 'OpenCode Session');
          session.externalId = sessionId;
          session.externalData = response.data;
          logger.info(`Created local session: ${session.id} linked to remote: ${sessionId}`);
        } else {
          logger.warn(`Remote session returned no data: ${JSON.stringify(response)}`);
        }
      } catch (e) {
        logger.error(`Failed to fetch remote session: ${e.message}`);
        await sendFeishuSessionNotFound(chatId, sessionId);
        return;
      }
    }
    const userSessions = sessionManager.getUserSessions(userId);
    userSessions.forEach(s => {
      if (s.id !== session.id && s.status === 'active') {
        sessionManager.updateSessionStatus(s.id, 'inactive');
      }
    });
    sessionManager.updateSessionStatus(session.id, 'active');
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Session Attached' }, template: 'blue' },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: `**Session ID:** ${session.id}` } },
        { tag: 'div', text: { tag: 'plain_text', content: session.description || 'No description' } },
        { tag: 'div', text: { tag: 'lark_md', content: '**Session is now active. Send commands to interact.**' } },
      ],
    };
    await sendFeishuCard(chatId, card);
  } catch (error) {
    logger.error('Attach session error:', error);
    await sendFeishuError(chatId, error.message);
  }
}

async function sendFeishuStatus(chatId) {
  try {
    let opencodeStatus = 'Unknown';
    let opencodeHealthy = false;
    try {
      await opencodeClient.session.list();
      opencodeHealthy = true;
      opencodeStatus = 'Connected';
    } catch (e) {
      opencodeStatus = `Error: ${e.message}`;
    }
    const activeSessions = Array.from(sessionManager.sessions.values()).filter(s => s.status === 'active').length;
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'System Status' }, template: opencodeHealthy ? 'green' : 'red' },
      elements: [
        { tag: 'div', fields: [
          { is_short: true, text: { tag: 'plain_text', content: `Active Sessions: ${activeSessions}` } },
          { is_short: true, text: { tag: 'plain_text', content: `Total Sessions: ${sessionManager.sessions.size + sessionManager.sessionHistory.size}` } },
        ]},
        { tag: 'div', text: { tag: 'lark_md', content: `**OpenCode Status:** ${opencodeStatus}\n**API URL:** ${config.opencodeApiUrl}` } },
      ],
    };
    await sendFeishuCard(chatId, card);
  } catch (error) {
    logger.error('Status error:', error);
    throw error;
  }
}

async function sendFeishuCommandResult(chatId, sessionId, command, result) {
  const card = {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: 'Command Result' }, template: 'blue' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**Session:** ${sessionId}` } },
      { tag: 'div', text: { tag: 'lark_md', content: `**Command:** \`${command}\`` } },
      { tag: 'div', text: { tag: 'lark_md', content: `**Result:**\n\`\`\`\n${result}\n\`\`\`` } },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: 'View Logs' }, type: 'default', value: JSON.stringify({ type: 'view_logs', sessionId }) },
        { tag: 'button', text: { tag: 'plain_text', content: 'Exit' }, type: 'danger', value: JSON.stringify({ type: 'stop_session', sessionId }) },
      ]},
    ],
  };
  await sendFeishuCard(chatId, card);
}

async function sendFeishuStreamingStart(chatId, sessionId, command) {
  const card = {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: 'Processing...' }, template: 'purple' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**Session:** ${sessionId}` } },
      { tag: 'div', text: { tag: 'lark_md', content: `**Command:** \`${command}\`` } },
      { tag: 'div', text: { tag: 'lark_md', content: '**Output:**\n```\n⏳ Waiting for response...\n```' } },
    ],
  };
  await sendFeishuCard(chatId, card);
}

async function sendFeishuStreamingUpdate(chatId, sessionId, text, isThinking = false) {
  const prefix = isThinking ? '🤔' : '📝';
  const card = {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: isThinking ? 'Thinking...' : 'Response' }, template: 'blue' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**Session:** ${sessionId}` } },
      { tag: 'div', text: { tag: 'lark_md', content: `${prefix} **${isThinking ? 'Thinking' : 'Output'}:**\n\`\`\`\n${text.substring(0, 2000)}\n\`\`\`` } },
    ],
  };
  await sendFeishuCard(chatId, card);
}

async function sendFeishuSessionEnded(chatId, sessionId) {
  const card = {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: 'Session Ended' }, template: 'gray' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**Session ID:** ${sessionId}` } },
      { tag: 'div', text: { tag: 'plain_text', content: 'Session has ended.' } },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: 'List Sessions' }, type: 'primary', value: JSON.stringify({ type: 'list_sessions' }) },
        { tag: 'button', text: { tag: 'plain_text', content: 'Create New' }, type: 'default', value: JSON.stringify({ type: 'create_session' }) },
      ]},
    ],
  };
  await sendFeishuCard(chatId, card);
}

async function sendFeishuSessionLogs(chatId, userId, sessionId) {
  const session = sessionManager.getSession(sessionId);
  if (!session || session.userId !== userId) {
    await sendFeishuSessionNotFound(chatId, sessionId);
    return;
  }
  const logs = session.logs.slice(-50);
  const logContent = logs.length > 0 ? logs.map(log => `${log.timestamp.toLocaleTimeString()}: ${log.content}`).join('\n') : 'No logs';
  const card = {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: 'Session Logs' }, template: 'purple' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**Session:** ${sessionId}` } },
      { tag: 'div', text: { tag: 'lark_md', content: `**Logs:** ${logs.length} entries` } },
      { tag: 'div', text: { tag: 'lark_md', content: `\`\`\`\n${logContent}\n\`\`\`` } },
    ],
  };
  await sendFeishuCard(chatId, card);
}

async function sendFeishuClearScreen(chatId, _sessionId) {
  const card = {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: 'Screen Cleared' }, template: 'gray' },
    elements: [
      { tag: 'div', text: { tag: 'plain_text', content: 'Screen has been cleared. Continue sending commands.' } },
    ],
  };
  await sendFeishuCard(chatId, card);
}

async function sendFeishuCommandError(chatId, sessionId, command, errorMessage) {
  const card = {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: 'Command Failed' }, template: 'red' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**Session:** ${sessionId}` } },
      { tag: 'div', text: { tag: 'lark_md', content: `**Command:** \`${command}\`` } },
      { tag: 'div', text: { tag: 'plain_text', content: `Error: ${errorMessage}` } },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: 'View Logs' }, type: 'default', value: JSON.stringify({ type: 'view_logs', sessionId }) },
      ]},
    ],
  };
  await sendFeishuCard(chatId, card);
}

async function sendFeishuError(chatId, errorMessage) {
  const card = {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: 'Error' }, template: 'red' },
    elements: [
      { tag: 'div', text: { tag: 'plain_text', content: `Error: ${errorMessage}` } },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: 'Help' }, type: 'default', value: JSON.stringify({ type: 'show_help' }) },
      ]},
    ],
  };
  await sendFeishuCard(chatId, card);
}

async function sendFeishuSessionNotFound(chatId, _sessionId) {
  const card = {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: 'Session Not Found' }, template: 'red' },
    elements: [
      { tag: 'div', text: { tag: 'plain_text', content: 'Session not found.' } },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: 'List Sessions' }, type: 'primary', value: JSON.stringify({ type: 'list_sessions' }) },
      ]},
    ],
  };
  await sendFeishuCard(chatId, card);
}

async function sendFeishuSessionAccessDenied(chatId, _sessionId) {
  const card = {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: 'Access Denied' }, template: 'red' },
    elements: [
      { tag: 'div', text: { tag: 'plain_text', content: 'You do not have permission to access this session.' } },
    ],
  };
  await sendFeishuCard(chatId, card);
}

async function sendFeishuUnknownCommand(chatId, command) {
  const card = {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: 'Unknown Command' }, template: 'yellow' },
    elements: [
      { tag: 'div', text: { tag: 'plain_text', content: `Unknown command: ${command}` } },
      { tag: 'div', text: { tag: 'plain_text', content: 'Use /opencode help for available commands.' } },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: 'Help' }, type: 'primary', value: JSON.stringify({ type: 'show_help' }) },
      ]},
    ],
  };
  await sendFeishuCard(chatId, card);
}

async function sendFeishuCard(chatId, card) {
  try {
    const accessToken = await getFeishuAccessToken();
    const response = await axios.post(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
      { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
      { headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    logger.info('Card sent successfully', { messageId: response.data?.data?.message_id });
    return response.data;
  } catch (error) {
    logger.error('Failed to send card:', error.response?.data || error.message);
    throw error;
  }
}

async function getFeishuAccessToken() {
  try {
    const response = await axios.post(
      'https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal',
      { app_id: config.feishuAppId, app_secret: config.feishuAppSecret },
      { headers: { 'Content-Type': 'application/json' } }
    );
    return response.data.app_access_token;
  } catch (error) {
    logger.error('Failed to get Feishu access token:', error);
    throw error;
  }
}

app.get('/test', (req, res) => {
  const testId = `test_${Date.now()}`;
  res.json({
    testId,
    message: 'Test endpoint active',
    endpoints: {
      health: 'GET /health',
      testListSessions: 'GET /test/sessions',
      testCreateSession: 'POST /test/sessions',
      testSendMessage: 'POST /test/sessions/:id/message',
      testDeleteSession: 'DELETE /test/sessions/:id',
    },
  });
});

app.get('/test/sessions', async (req, res) => {
  try {
    const response = await opencodeClient.session.list();
    res.json({
      success: true,
      count: response.data?.length || 0,
      sessions: response.data || [],
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      type: error.constructor.name,
    });
  }
});

app.post('/test/sessions', async (req, res) => {
  try {
    const { title, description } = req.body;
    const response = await opencodeClient.session.create({
      body: { title: title || description || 'Test Session' },
    });
    res.json({
      success: true,
      session: response.data,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      type: error.constructor.name,
    });
  }
});

app.get('/test/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const response = await opencodeClient.session.get({ path: { id } });
    res.json({
      success: true,
      session: response.data,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      type: error.constructor.name,
    });
  }
});

app.post('/test/sessions/:id/message', async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }
    const response = await opencodeClient.session.prompt({
      path: { id },
      body: {
        parts: [{ type: "text", text: message }],
      },
    });
    res.json({
      success: true,
      response: response.data,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      type: error.constructor.name,
    });
  }
});

app.delete('/test/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await opencodeClient.session.delete({ path: { id } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      type: error.constructor.name,
    });
  }
});

app.post('/test/simulate-error', (req, res) => {
  const { type, message } = req.body;
  switch (type) {
    case 'network':
      res.status(500).json({ success: false, error: 'Network error simulation' });
      break;
    case 'timeout':
      setTimeout(() => res.json({ success: true }), 5000);
      break;
    case 'api':
      res.status(401).json({ success: false, error: 'API error simulation' });
      break;
    default:
      res.json({ success: true, message: message || 'No error simulated' });
  }
});

async function startServer() {
  await initOpenCodeClient();
  const server = app.listen(config.port, config.host, () => {
    logger.info(`OpenCode Feishu Bot started on http://${config.host}:${config.port}`);
    logger.info(`Health check: http://${config.host}:${config.port}/health`);
    logger.info(`Test endpoint: http://${config.host}:${config.port}/test`);
  });
  return server;
}

let serverInstance;
startServer().then(server => {
  serverInstance = server;
}).catch(err => {
  logger.error('Failed to start server:', err);
  process.exit(1);
});

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down...');
  clearInterval(sessionManager.cleanupInterval);
  if (serverInstance) {
    serverInstance.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down...');
  clearInterval(sessionManager.cleanupInterval);
  if (serverInstance) {
    serverInstance.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection:', { reason, promise });
});

module.exports = app;

module.exports = app;
