import { handle } from 'hono/vercel';
import app from '../server.js';

export const config = { runtime: 'nodejs' };

export default handle(app);
