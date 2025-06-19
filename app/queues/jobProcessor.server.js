import { processInventoryLevelUpdate, processOrderCancellation, processProductCreate, processProductUpdate, processWebhookPayloadWithSKUs, processRefund } from "../utils/helper";

// Single worker to process all webhook types
export const processWebhook = async (job) => {
    const { session, type, payload } = job.data;
    // console.log(payload)
    try {
        let result;
        switch (type) {
            case "order_create":
                console.log(">>> 📦 Processing order creation");
                result = await processWebhookPayloadWithSKUs(session, payload);
                // await new Promise(resolve => setTimeout(resolve, 15000));
                break;

            case "inventory_update":
                console.log(">>> 📊 Processing inventory update");
                result = await processInventoryLevelUpdate(session, payload);
                // await new Promise(resolve => setTimeout(resolve, 15000));
                break;

            case "order_cancelled":
            case "order_fulfilled":
                console.log(">>> 🔄 Processing order status change:", type);
                result = await processOrderCancellation(
                    session,
                    payload,
                    type.split("_")[1],
                );
                // await new Promise(resolve => setTimeout(resolve, 15000));
                break;

            case "product_create":
                console.log(">>> ➕ Processing product creation");
                result = await processProductCreate(session, payload);
                // await new Promise(resolve => setTimeout(resolve, 15000));
                break;

            case "product_update":
                console.log(">>> 🔄 Processing product update");
                result = await processProductUpdate(session, payload);
                // await new Promise(resolve => setTimeout(resolve, 15000));
                break;

            case "refund_create":
                console.log(">>> 💰 Processing refund");
                result = await processRefund(session, payload);
                break;

            default:
                console.log("⚠️ Unknown webhook type:", type);
                result = {
                    success: false,
                    error: `Unknown webhook type: ${type}`,
                };
        }

        console.log(`✅ Webhook job ${job.id} completed:`, {
            type,
            success: result.success,
            error: result.error,
        });

        return result;
    } catch (error) {
        console.error(`❌ Webhook job ${job.id} failed:`, {
            type,
            error: error.message,
            stack: error.stack,
        });
        return {
            success: false,
            error: error.message,
        };
    }
};
