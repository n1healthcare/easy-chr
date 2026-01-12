import fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import path from 'path';
import fs from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { GeminiAdapter } from '../gemini/gemini.adapter.js';
import { SendChatUseCase } from '../../application/use-cases/send-chat.use-case.js';
import { GenerateRealmUseCase } from '../../application/use-cases/generate-realm.use-case.js';
import { ResearchSectionUseCase } from '../../application/use-cases/research-section.use-case.js';

export async function createServer() {
  const server = fastify({
    logger: true,
  });

  await server.register(cors, {
    origin: '*',
  });

  await server.register(multipart, {
    limits: {
      fileSize: 300 * 1024 * 1024, // 300MB
      files: 300,
    }
  });

  // Serve generated realms statically
  await server.register(fastifyStatic, {
    root: path.join(process.cwd(), 'storage', 'realms'),
    prefix: '/realms/',
  });

  // Dependency Injection
  const geminiAdapter = new GeminiAdapter();
  await geminiAdapter.initialize();

  const sendChatUseCase = new SendChatUseCase(geminiAdapter);
  const generateRealmUseCase = new GenerateRealmUseCase(geminiAdapter);
  const researchSectionUseCase = new ResearchSectionUseCase(geminiAdapter);

  server.post('/api/chat', async (request, reply) => {
    const { message, sessionId } = request.body as { message: string, sessionId?: string };
    const finalSessionId = sessionId || 'default-session';

    try {
      const stream = await sendChatUseCase.execute(message, finalSessionId);
      const readableStream = Readable.from(stream);
      return reply.send(readableStream);
    } catch (error) {
      request.log.error(error);
      reply.status(500).send({ error: 'Internal Server Error' });
    }
  });

  const researchBodySchema = {
    type: 'object',
    required: ['sectionContext'],
    properties: {
      sectionContext: { type: 'string', minLength: 1 },
      userQuery: { type: 'string' },
    },
  };

  server.post('/api/research', { schema: { body: researchBodySchema } }, async (request, reply) => {
    const { sectionContext, userQuery } = request.body as { sectionContext: string, userQuery?: string };

    try {
      const stream = researchSectionUseCase.execute(sectionContext, userQuery);
      const readableStream = Readable.from(stream);
      return reply.send(readableStream);
    } catch (error) {
      request.log.error(error);
      reply.status(500).send({ error: 'Internal Server Error' });
    }
  });

  server.post('/api/realm', async (request, reply) => {
    const parts = request.parts();
    const uploadedFilePaths: string[] = [];
    let prompt = "Visualize this document.";
    
    const uploadDir = path.join(process.cwd(), 'storage', 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    for await (const part of parts) {
      if (part.type === 'file') {
        const filePath = path.join(uploadDir, `${Date.now()}-${part.filename}`);
        await pipeline(part.file, fs.createWriteStream(filePath));
        uploadedFilePaths.push(filePath);
      } else if (part.type === 'field' && part.fieldname === 'prompt') {
        prompt = (part.value as string) || prompt;
      }
    }

    if (uploadedFilePaths.length === 0) {
      return reply.status(400).send({ error: 'At least one file is required' });
    }

    try {
      // Set SSE headers
      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('Access-Control-Allow-Origin', '*');

      const generator = generateRealmUseCase.execute(prompt, uploadedFilePaths);

      for await (const event of generator) {
        reply.raw.write(`event: ${event.type}\n`);
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      
      reply.raw.end();
    } catch (error) {
      request.log.error(error);
      // If we already started sending headers, we can't send a 500 status code cleanly
      // But we can send an error event
      reply.raw.write(`event: error\n`);
      reply.raw.write(`data: ${JSON.stringify({ error: 'Internal Server Error' })}\n\n`);
      reply.raw.end();
    }
  });

  return server;
}
