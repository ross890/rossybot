// ===========================================
// TWITTER AUTH UTILITY
// Generates Bearer Token from Consumer Key/Secret
// ===========================================

import axios from 'axios';
import { logger } from './logger.js';

/**
 * Generate a Twitter API Bearer Token from Consumer Key and Secret
 * Uses OAuth 2.0 Client Credentials flow
 */
export async function generateBearerToken(
  consumerKey: string,
  consumerSecret: string
): Promise<string> {
  try {
    // Base64 encode the consumer key and secret
    const credentials = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    
    const response = await axios.post(
      'https://api.twitter.com/oauth2/token',
      'grant_type=client_credentials',
      {
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
      }
    );
    
    if (response.data.token_type !== 'bearer') {
      throw new Error('Unexpected token type received');
    }
    
    logger.info('Successfully generated Twitter Bearer Token');
    return response.data.access_token;
  } catch (error) {
    logger.error('Failed to generate Twitter Bearer Token:', error);
    throw error;
  }
}

/**
 * Get a valid Bearer Token - either from env or generate from consumer keys
 */
export async function getTwitterBearerToken(
  bearerToken?: string,
  consumerKey?: string,
  consumerSecret?: string
): Promise<string | null> {
  // If we have a valid bearer token (not placeholder), use it
  if (bearerToken && bearerToken.length > 30 && !bearerToken.includes('PLACEHOLDER')) {
    return bearerToken;
  }
  
  // Otherwise try to generate from consumer keys
  if (consumerKey && consumerSecret) {
    try {
      return await generateBearerToken(consumerKey, consumerSecret);
    } catch (error) {
      logger.warn('Could not generate Twitter Bearer Token - social signals will be limited');
      return null;
    }
  }
  
  logger.warn('No Twitter credentials available - social signals will be limited');
  return null;
}
