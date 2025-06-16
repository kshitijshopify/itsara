import { Queue, Worker } from "bullmq";
import redisClient from "../config/redis.server";
import { processWebhook } from "./jobProcessor.server";

// Single queue for all webhook processing
const queueConfig = {
  connection: redisClient,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: false,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000
    }
  }
};

export const webhookQueue = new Queue("webhook-processing", queueConfig);

// Log queue status when a job is added
webhookQueue.on("waiting", (job) => {
  console.log(`📥 Job ${job.id} is waiting in the queue`);
});

// Worker configuration
const workerConfig = {
  connection: redisClient,
  concurrency: 1, // Process one job at a time
  settings: {
    stalledInterval: 30000,
    maxStalledCount: 1,
    lockDuration: 60000, // Increased lock duration to 60 seconds
    lockRenewTime: 30000, // Renew lock every 30 seconds
    drainDelay: 5 // Add delay between jobs
  },
  limiter: {
    max: 1,
    duration: 1000
  }
};

// Singleton worker instance
let workerInstance = null;

export const getWorker = () => {
  if (!workerInstance) {
    // Check if there's already a worker running
    const workerName = `webhook-processing-${process.pid}`;
    
    workerInstance = new Worker(
      "webhook-processing",
      processWebhook,
      {
        ...workerConfig,
        name: workerName, // Unique name for this worker instance
        autorun: true,
        settings: {
          ...workerConfig.settings,
          lockRenewTime: 30000,
          drainDelay: 5
        }
      }
    );

    workerInstance.on("active", (job) => {
      console.log(`🚀🚀🚀 Job ${job.name}::${job.id} is now being processed by worker ${workerName}`);
    });

    workerInstance.on("completed", (job) => {
      console.log(`✅✅✅ Job ${job.name}::${job.id} completed successfully`);
    });

    workerInstance.on("failed", (job, err) => {
      console.error(`❌❌❌ Job ${job?.name}::${job?.id} failed:`, err);
    });

    workerInstance.on("error", (err) => {
      console.error("‼️‼️‼️ Worker error:", err);
    });

    // Handle worker cleanup
    process.on("SIGTERM", async () => {
      console.log(`Shutting down worker ${workerName}...`);
      if (workerInstance) {
        await workerInstance.close();
        workerInstance = null;
      }
    });
  }
  return workerInstance;
};

// Initialize the worker
export const webhookWorker = getWorker();
