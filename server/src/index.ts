import dotenv from 'dotenv';
import { createServer } from './adapters/http/server.js';

dotenv.config();

const start = async () => {
  try {
    const server = await createServer();
    const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
    await server.listen({ port, host: '0.0.0.0' });
    console.log(`Server listening on port ${port}`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

start();
