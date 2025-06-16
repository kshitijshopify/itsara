import { authenticate } from "../shopify.server";
import { webhookQueue } from "../queues/queue.server";

export const action = async ({ request }) => {
  const { session, shop, topic, payload } = await authenticate.webhook(request);

  console.log(`🔔 Webhook received:`, {
    type: 'inventory_update',
    shop,
    payloadId: payload.inventory_item_id
  });
  
  // Add job to unified webhook queue with default settings
  await webhookQueue.add('webhook-job', {
    session,
    type: 'inventory_update',
    payload
  });

  return new Response("✅ Webhook received and queued for processing", { status: 200 });
};
