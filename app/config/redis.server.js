import Redis from 'ioredis';

// Redis configuration
const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD,
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  }
};

// Create Redis client
export const redisClient = new Redis(redisConfig);

// Error handling
redisClient.on('error', (err) => {
  console.error('Redis Client Error:', err);
});

redisClient.on('connect', async () => {
  console.log('Redis Client Connected');
  
  // Check eviction policy
  try {
    const config = await redisClient.config('GET', 'maxmemory-policy');
    if (config[1] !== 'noeviction') {
      console.warn('⚠️ Redis eviction policy is set to:', config[1]);
      console.warn('⚠️ For optimal queue performance, set maxmemory-policy to "noeviction"');
      console.warn('⚠️ You can set this in your Redis configuration or through your Redis provider');
    }
  } catch (err) {
    // If we can't check the policy, just log a warning
    console.warn('⚠️ Unable to check Redis eviction policy. For optimal queue performance, ensure maxmemory-policy is set to "noeviction"');
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Closing Redis connection...');
  await redisClient.quit();
});

export default redisClient; 