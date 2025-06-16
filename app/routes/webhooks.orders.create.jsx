import { authenticate } from "../shopify.server";
import { webhookQueue } from "../queues/queue.server";

export const action = async ({ request }) => {
  const { session, shop, topic, payload } = await authenticate.webhook(request);

  console.log(`🔔 Webhook received:`, {
    type: 'order_create',
    shop,
    payloadId: payload.id
  });
  
  // Add job to unified webhook queue with default settings
  await webhookQueue.add('webhook-job', {
    session,
    type: 'order_create',
    payload
  });

  return new Response("✅ Webhook received and queued for processing", { status: 200 });
};
