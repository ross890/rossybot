// ===========================================
// LOGGER UTILITY
// ===========================================

import pino from 'pino';
import { appConfig } from '../config/index.js';

export const logger = pino({
  level: appConfig.logLevel,
  transport: appConfig.nodeEnv === 'development' ? {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  } : undefined,
  base: {
    env: appConfig.nodeEnv,
  },
});

export default logger;
