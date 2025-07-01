import db from "../db.server";
import {
  insertOrdersGroupedByDate,
  processWebhookPayload,
  ensureSheetHasHeader,
  upsertRowsToGoogleSheet,
  getSheetId,
  getSheet,
  addSheetOrderHeader,
  updateSubSkuWithOrderInfo,
  ensureSheetTabExists,
  groupByDate,
  auth,
  prependDataToSheet
} from "./googleSheet.server";
import { makeShopifyGraphQLRequest } from "../utils/shopify.server";
import { google } from "googleapis";
import process from "process";

export async function getAllLocations(session) {
  const query = `
      query {
        locations(first: 20) {
          edges {
            node {
              id
              name
            }
          }
        }
      }
    `;

  const data = await makeShopifyGraphQLRequest(session, query);
  return data.data.locations.edges.map((edge) => edge.node);
}

export async function getInventoryLevels(session, inventoryItemId) {
  const query = `
      query GetInventoryLevels($inventoryItemId: ID!) {
        inventoryItem(id: $inventoryItemId) {
          inventoryLevels(first: 10) {
            edges {
              node {
                location {
                  id
                }
                quantities(names: ["available"]) {
                  name
                  quantity
                }
              }
            }
          }
        }
      }
    `;

  const data = await makeShopifyGraphQLRequest(session, query, {
    inventoryItemId,
  });

  return data.data.inventoryItem.inventoryLevels.edges.map((edge) => edge.node);
}

export async function setInventoryQuantity(
  admin,
  inventoryItemId,
  delta,
  locationId,
) {
  const mutation = `
      mutation adjustInventory($input: InventoryAdjustQuantitiesInput!) {
        inventoryAdjustQuantities(input: $input) {
          inventoryAdjustmentGroup {
            createdAt
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

  const variables = {
    input: {
      name: "available",
      reason: "correction",
      changes: [
        {
          inventoryItemId,
          locationId,
          delta: delta, // Calculate the delta (positive or negative)
        },
      ],
    },
  };

  const res = await admin.graphql(mutation, { variables });
  const json = await res.json();

  if (
    json.errors ||
    json.data?.inventoryAdjustQuantities?.userErrors?.length > 0
  ) {
    console.error("Inventory adjustment error for", inventoryItemId);
    console.error(
      JSON.stringify(
        json.errors || json.data.inventoryAdjustQuantities.userErrors,
        null,
        2,
      ),
    );
  }

  return json;
}

export async function getInventoryItem(session, inventoryItemId) {
  const query = `
    query getInventoryItem($inventoryItemId: ID!) {
      inventoryItem(id: $inventoryItemId) {
        id
        title
        product {
          id
          title
        }
      }
    }
  `;

  const data = await makeShopifyGraphQLRequest(session, query, {
    inventoryItemId,
  });
  return data.data.inventoryItem;
}

export async function getInventoryItemBySKU(session, sku) {
  const query = `
    query getInventoryItemBySKU($sku: String!) {
      inventoryItem(sku: $sku) {
        id
        title   
        product {
          id
          title
        }
      }
    }
  `;

  const data = await makeShopifyGraphQLRequest(session, query, { sku });
  return data.data.inventoryItem;
}

/**
 * Get available quantity for a specific SKU or all SKUs
 * @param {string} [sku] - Optional SKU to check. If not provided, returns all SKUs
 * @returns {Promise<{ sku: string, totalQuantity: number, availableQuantity: number, availableSubSkus: Array<{name: string, status: string}> }[]>}
 */
export async function getAvailableSKUs(sku = null) {
  try {
    const query = sku ? { sku } : {};

    const skus = await db.SKU.findMany({
      where: query,
    });

    return skus.map((skuItem) => {
      // Ensure subSKU exists and is an array
      if (!skuItem?.subSKU || !Array.isArray(skuItem.subSKU)) {
        return {
          sku: skuItem.sku,
          totalQuantity: 0,
          availableQuantity: 0,
          availableSubSkus: [],
        };
      }

      // First sort all subSKUs by their number to ensure sequential order
      const sortedSubSKUs = skuItem.subSKU.sort((a, b) => {
        // Extract numbers from subSKU names (e.g., "SKU-0001" -> 1)
        const numA = parseInt(a.name?.split("-").pop() || "0");
        const numB = parseInt(b.name?.split("-").pop() || "0");
        return numA - numB;
      });

      // Then filter available subSKUs while maintaining the sorted order
      const availableSubSkus = sortedSubSKUs.filter(
        (subSku) => subSku?.status === "available"
      );

      console.log({availableSubSkus, sortedSubSKUs}, "availableSubSkus");
      return {
        sku: skuItem.sku,
        totalQuantity: skuItem.subSKU.length,
        availableQuantity: availableSubSkus.length,
        availableSubSkus, // This will now be in correct sequential order
      };
    });
  } catch (error) {
    console.error("Error fetching SKU availability:", error);
    throw error;
  }
}

/**
 * Check if a specific SKU has available quantity
 * @param {string} sku - SKU to check
 * @param {number} quantity - Quantity needed
 * @returns {Promise<boolean>}
 */
export async function hasAvailableQuantity(sku, quantity) {
  try {
    const [skuData] = await getAvailableSKUs(sku);
    return skuData && skuData.availableQuantity >= quantity;
  } catch (error) {
    console.error(`Error checking quantity for SKU ${sku}:`, error);
    throw error;
  }
}

/**
 * Get the next available subSKU for a given SKU
 * @param {string} sku - Base SKU to get next available subSKU from
 * @returns {Promise<string|null>} - Returns the next available subSKU or null if none available
 */
export async function getNextAvailableSubSKU(sku) {
  try {
    const [skuData] = await getAvailableSKUs(sku);
    if (!skuData || skuData.availableQuantity === 0) {
      return null;
    }

    // Since availableSubSkus is already sorted by getAvailableSKUs,
    // we can just take the first one which will be the lowest number
    return skuData.availableSubSkus[0].name;
  } catch (error) {
    console.error(`Error getting next available subSKU for ${sku}:`, error);
    throw error;
  }
}

/**
 * Update the status of multiple subSKUs in a single operation
 * @param {string} baseSku - The base SKU
 * @param {Array<string>} subSkuNames - Array of subSKU names to update
 * @param {string} newStatus - The new status to set
 * @returns {Promise<boolean>} - Returns true if update was successful
 */
export async function updateSubSKUStatus(baseSku, subSkuNames, newStatus) {
  try {
    console.log('🔄 Updating subSKU statuses:', {
      baseSku,
      subSkuNames,
      newStatus
    });

    if (!baseSku || !subSkuNames || !newStatus) {
      throw new Error('Missing required parameters');
    }

    // Convert single subSkuName to array for consistent handling
    const subSkuNamesArray = Array.isArray(subSkuNames) ? subSkuNames : [subSkuNames];

    const sku = await db.SKU.findUnique({
      where: { sku: baseSku },
    });

    if (!sku) {
      throw new Error(`SKU ${baseSku} not found`);
    }

    if (!Array.isArray(sku.subSKU)) {
      throw new Error(`Invalid subSKU data for SKU ${baseSku}`);
    }

    // Update all specified subSKUs in a single operation
    const updatedSubSKUs = sku.subSKU.map((subSku) => {
      if (subSkuNamesArray.includes(subSku.name)) {
        return { ...subSku, status: newStatus };
      }
      return subSku;
    });

    await db.SKU.update({
      where: { sku: baseSku },
      data: {
        subSKU: updatedSubSKUs,
      },
    });

    console.log('✅ Successfully updated subSKU statuses:', {
      baseSku,
      subSkuNames: subSkuNamesArray,
      newStatus
    });

    return true;
  } catch (error) {
    console.error('❌ Error updating subSKU statuses:', {
      baseSku,
      subSkuNames,
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

/**
 * Add new subSKUs to an existing base SKU
 * @param {string} baseSku - The base SKU to add subSKUs to
 * @param {number} quantity - Number of new subSKUs to add
 * @returns {Promise<boolean>} - Returns true if addition was successful
 */
export async function addSubSKUsToBase(baseSku, quantity) {
  try {
    const sku = await db.SKU.findUnique({
      where: { sku: baseSku },
    });

    if (!sku) {
      throw new Error(`SKU ${baseSku} not found`);
    }

    // Get the current highest subSKU number
    const currentSubSKUs = sku.subSKU || [];
    let highestNumber = 0;

    if (currentSubSKUs.length > 0) {
      const numbers = currentSubSKUs.map((subSku) => {
        const match = subSku.name.match(/\d+$/);
        return match ? parseInt(match[0]) : 0;
      });
      highestNumber = Math.max(...numbers);
    }

    // Create new subSKUs
    const newSubSKUs = [];
    for (let i = 1; i <= quantity; i++) {
      const subSKUNumber = String(highestNumber + i).padStart(4, "0");
      newSubSKUs.push({
        name: `${baseSku}-${subSKUNumber}`,
        status: "available",
      });
    }

    // Update the SKU with combined subSKUs
    await db.SKU.update({
      where: { sku: baseSku },
      data: {
        subSKU: [...currentSubSKUs, ...newSubSKUs],
      },
    });

    return true;
  } catch (error) {
    console.error(`Error adding subSKUs to ${baseSku}:`, error);
    throw error;
  }
}

/**
 * Remove specific subSKUs from a base SKU
 * @param {string} baseSku - The base SKU to remove subSKUs from
 * @param {string[]} subSkuNames - Array of subSKU names to remove
 * @returns {Promise<boolean>} - Returns true if removal was successful
 */
export async function removeSubSKUsByQuantity(baseSku, quantity = 1) {
  try {
    const sku = await db.SKU.findUnique({
      where: { sku: baseSku },
    });

    if (!sku) {
      throw new Error(`SKU ${baseSku} not found`);
    }

    // Get only available subSKUs
    const availableSubSKUs = sku.subSKU.filter(
      (subSku) => subSku.status === "available",
    );

    if (availableSubSKUs.length < quantity) {
      throw new Error(
        `Not enough available subSKUs for ${baseSku}. Requested: ${quantity}, Available: ${availableSubSKUs.length}`,
      );
    }

    // Get the last N available subSKUs to remove based on quantity parameter
    const subSKUsToRemove = availableSubSKUs
      .slice(-quantity)  // Changed to use quantity parameter
      .map((subSku) => subSku.name);

    // Keep all subSKUs except the ones in subSKUsToRemove
    const updatedSubSKUs = sku.subSKU.filter(
      (subSku) => !subSKUsToRemove.includes(subSku.name),
    );

    // Update the SKU with remaining subSKUs
    console.log("🔄 Updating SKU:", {
      sku: baseSku,
      updatedSubSKUs,
    });
    await db.SKU.update({
      where: { sku: baseSku },
      data: {
        subSKU: updatedSubSKUs,
      },
    });

    return true;
  } catch (error) {
    console.error(
      `Error removing last ${quantity} available subSKUs from ${baseSku}:`,
      error,
    );
    throw error;
  }
}

// Rate limiting helper
const rateLimitDelay = 500; // 500ms delay between requests
let lastRequestTime = 0;

/**
 * Handles rate limiting for Shopify API calls
 * @returns {Promise<void>}
 */
async function handleRateLimit() {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;

  if (timeSinceLastRequest < rateLimitDelay) {
    await new Promise((resolve) =>
      setTimeout(resolve, rateLimitDelay - timeSinceLastRequest),
    );
  }

  lastRequestTime = Date.now();
}

/**
 * Makes a rate-limited GraphQL request to Shopify
 * @param {object} admin - Shopify admin client
 * @param {string} query - GraphQL query
 * @param {object} variables - Query variables
 * @returns {Promise<object>} Query response
 */
async function makeShopifyRequest(admin, query, variables) {
  try {
    await handleRateLimit();

    const response = await admin.graphql(query, { variables });
    const data = await response.json();

    // Check for throttling errors
    if (data.errors) {
      const throttleError = data.errors.find(
        (error) =>
          error.message?.includes("Throttled") ||
          error.message?.includes("Rate limit"),
      );

      if (throttleError) {
        // Wait longer and retry once
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await handleRateLimit();
        const retryResponse = await admin.graphql(query, { variables });
        return await retryResponse.json();
      }
    }

    return data;
  } catch (error) {
    if (
      error.message?.includes("Throttled") ||
      error.message?.includes("Rate limit")
    ) {
      // Wait and retry once
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await handleRateLimit();
      const retryResponse = await admin.graphql(query, { variables });
      return await retryResponse.json();
    }
    throw error;
  }
}

/**
 * Create or update a SKU entry in the database
 * @param {string} sku - The SKU to create/update
 * @param {number} quantity - Initial quantity to create
 * @returns {Promise<Object>} - Returns the created/updated SKU object
 */
export async function createNewSKU(sku, quantity = 0) {
  try {
    // First check if SKU exists
    const existingSKU = await db.SKU.findUnique({
      where: { sku }
    });

    // Generate subSKUs
    const subSKUs = Array.from({ length: quantity }, (_, i) => ({
      name: `${sku}-${String(i + 1).padStart(4, '0')}`,
      status: 'available'
    }));

    if (!existingSKU) {
      // Create new SKU if it doesn't exist
      const newSKU = await db.SKU.create({
        data: {
          sku: sku,
          subSKU: subSKUs
        }
      });
      console.log(`✅ Created new SKU ${sku} with ${quantity} subSKUs`);
      return newSKU;
    } else if (existingSKU?.subSKU?.length === 0) {
      // Update only if subSKU array is empty
      const updatedSKU = await db.SKU.update({
        where: { sku },
        data: {
          subSKU: subSKUs
        }
      });
      console.log(`✅ Updated SKU ${sku} with ${quantity} subSKUs`);
      return updatedSKU;
    }

    // If SKU exists and has subSKUs, return existing
    console.log(`ℹ️ SKU ${sku} already exists with ${existingSKU?.subSKU?.length} subSKUs`);
    return existingSKU;
  } catch (error) {
    console.error(`Error creating/updating SKU ${sku}:`, error);
    throw error;
  }
}

/**
 * Process inventory level update from webhook with automatic SKU creation
 * @param {object} session - Shopify session client
 * @param {object} payload - Webhook payload containing inventory_item_id and available quantity
 */
export async function processInventoryLevelUpdate(session, payload) {
  try {
    console.log('🔍 Starting inventory level update:', {
      inventory_item_id: payload.inventory_item_id,
      available: payload.available
    });

    const { inventory_item_id, available: shopifyQuantity } = payload;

    // Get SKU using inventory_item_id
    console.log('🔄 Fetching inventory item details...');
    const data = await makeShopifyGraphQLRequest(
      session,
      `
      query getInventoryItem($id: ID!) {
        inventoryItem(id: $id) {
          id
          sku
          variant {
            sku
            product {
              title
            }
          }
        }
      }
    `,
      {
        id: `gid://shopify/InventoryItem/${inventory_item_id}`,
      },
    );

    console.log('📥 Received inventory item data:', {
      hasData: !!data.data?.inventoryItem,
      sku: data.data?.inventoryItem?.variant?.sku,
      productTitle: data?.data?.inventoryItem?.variant?.product?.title
    });

    const sku = data?.data?.inventoryItem?.variant?.sku;
    const productTitle = data?.data?.inventoryItem?.variant?.product?.title;

    if (!sku) {
      console.error('❌ No SKU found for inventory item:', inventory_item_id);
      return {
        success: false,
        error: "No SKU found for inventory item",
      };
    }

    // Try to get existing SKU data
    console.log('🔄 Checking existing SKU data...');
    let [skuData] = await getAvailableSKUs(sku);

    // If SKU doesn't exist, create it
    if (!skuData) {
      console.log('➕ Creating new SKU:', {
        sku,
        productTitle,
        initialQuantity: shopifyQuantity
      });
      await createNewSKU(sku, shopifyQuantity);
      [skuData] = await getAvailableSKUs(sku);
      console.log('✅ New SKU created:', {
        sku,
        totalQuantity: skuData.totalQuantity,
        availableQuantity: skuData.availableQuantity
      });
    }

    const ourQuantity = skuData.availableQuantity;

    console.log('📊 Quantity comparison:', {
      sku,
      ourQuantity,
      shopifyQuantity,
      difference: ourQuantity - shopifyQuantity
    });

    // Compare quantities and take action
    if (ourQuantity < shopifyQuantity) {
      // Need to add more subSKUs
      const toAdd = shopifyQuantity - ourQuantity;
      
      console.log('➕ Adding new subSKUs:', {
        sku,
        toAdd,
        currentQuantity: ourQuantity,
        targetQuantity: shopifyQuantity
      });
      
      // Generate new subSKUs starting from the next number
      const currentSubSKUs = skuData.availableSubSkus || [];
      let lastNumber = 0;
      
      if (currentSubSKUs.length > 0) {
        const lastSubSKU = currentSubSKUs[currentSubSKUs.length - 1];
        // Add null check for name property and provide default value
        const lastNumberStr = lastSubSKU?.name?.split("-").pop() || "0";
        lastNumber = parseInt(lastNumberStr);
      }
      
      console.log("Data>>>>", {lastNumber, currentSubSKUs, skuData, sku});
      
      const newSubSKUs = Array.from({ length: toAdd }, (_, i) => ({
        name: `${sku}-${String(lastNumber + i + 1).padStart(4, "0")}`,
        status: "available",
      }));

      // Update SKU with additional subSKUs
      await db.SKU.update({
        where: { sku },
        data: {
          subSKU: {
            push: newSubSKUs,
          },
        },
      });

      console.log('✅ Added new subSKUs:', {
        sku,
        added: toAdd,
        newSubSKUs: newSubSKUs.map(s => s.name)
      });

      return {
        success: true,
        data: {
          sku,
          action: "added",
          quantity: toAdd,
          ourQuantity,
          shopifyQuantity,
        },
      };
    } else if (ourQuantity > shopifyQuantity) {
      // Need to remove subSKUs - only remove available subSKUs
      const toRemove = ourQuantity - shopifyQuantity;
      
      console.log('➖ Removing available subSKUs:', {
        sku,
        toRemove,
        currentQuantity: ourQuantity,
        targetQuantity: shopifyQuantity
      });

      // removeSubSKUsByQuantity already only removes available subSKUs
      await removeSubSKUsByQuantity(sku, toRemove);

      console.log('✅ Removed available subSKUs:', {
        sku,
        removed: toRemove
      });

      return {
        success: true,
        data: {
          sku,
          action: "removed",
          quantity: toRemove,
          ourQuantity,
          shopifyQuantity,
        },
      };
    }

    console.log('ℹ️ No quantity adjustment needed:', {
      sku,
      ourQuantity,
      shopifyQuantity
    });

    return {
      success: true,
      data: {
        sku,
        action: "none",
        ourQuantity,
        shopifyQuantity,
      },
    };
  } catch (error) {
    console.error('❌ Error processing inventory level update:', {
      error: error.message,
      stack: error.stack,
      inventory_item_id: payload.inventory_item_id
    });
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Process new product creation webhook
 * @param {object} session - Shopify session client
 * @param {object} payload - Product creation webhook payload
 */
export async function processProductCreate(session, payload) {
  try {
    const variants = payload.variants || [];
    const results = [];
    const sheetData = [];

    // First ensure sheet has proper headers
    await ensureSheetHasHeader();

    // Use product date for time display in rows
    const productDate = new Date(payload.updated_at || payload.created_at);
    const timeParisZone = productDate.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris' });

    // Prepare variants with weight data for database storage
    const variantsWithWeight = [];

    for (const variant of variants) {
      const sku = variant.sku;
      if (!sku) continue;

      // Get variant weight using REST API
      let weightInGrams = null;
      try {
        const variantResponse = await fetch(
          `https://${session.shop}/admin/api/2025-01/variants/${variant.id}.json?fields=weight_unit,weight`,
          {
            headers: {
              'X-Shopify-Access-Token': session.accessToken,
            },
          }
        );

        const variantData = await variantResponse.json();
        const variantWeight = variantData.variant;

        // Convert weight to grams based on weight unit
        if (variantWeight?.weight && variantWeight?.weight_unit) {
          switch (variantWeight.weight_unit.toLowerCase()) {
            case 'kg':
              weightInGrams = variantWeight.weight * 1000;
              break;
            case 'g':
              weightInGrams = variantWeight.weight;
              break;
            case 'lb':
              weightInGrams = variantWeight.weight * 453.592;
              break;
            case 'oz':
              weightInGrams = variantWeight.weight * 28.3495;
              break;
          }
        }
      } catch (error) {
        console.error(`Error fetching variant weight for ${sku}:`, error);
      }

      // Store variant with weight for database
      variantsWithWeight.push({
        ...variant,
        weight_in_gram: weightInGrams || 0
      });

      // Create SKU if it doesn't exist
      let [skuData] = await getAvailableSKUs(sku);
      if (!skuData) {
        await createNewSKU(sku, variant.inventory_quantity || 0);
        [skuData] = await getAvailableSKUs(sku);
      }

      results.push({
        sku,
        success: true,
        quantity: skuData.totalQuantity,
        availableQuantity: skuData.availableQuantity,
      });

      // Add each subSKU as a separate row in the sheet
      skuData.availableSubSkus.forEach((subSku) => {
        sheetData.push([
          "", // Empty date cell since we have the date header
          timeParisZone, // Time (Paris Time Zone)
          payload.title, // Item Title
          sku, // SKU
          subSku.name, // Sub-SKU
          variant.title || "", // Variant
          weightInGrams || "", // Input Weight (in grams)
          "", // Input Reason
          "", // Free Handwritten Note
          payload.vendor, // "Supplier Name"
          "", // "Supplier Address"
        ]);
      });
    }

    // Update Google Sheet with all the data
    console.log(sheetData.length, "sheetData length");
    if (sheetData.length > 0) {
      console.log(`Adding ${sheetData.length} rows to Google Sheet for product ${payload.title}`);
      
      // Use the new prepend function
      await prependDataToSheet("Inventory Updates", sheetData, 3);

      console.log(`✅ Successfully prepended ${sheetData.length} rows to Google Sheet`);
    }

    // Save product data to database
    const payloadWithWeight = {
      ...payload,
      variants: variantsWithWeight
    };
    await saveProductToDatabase(payloadWithWeight);

    return {
      success: true,
      data: {
        results,
        sheetRowsAdded: sheetData.length,
      },
    };
  } catch (error) {
    console.error("Error processing product creation:", error);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Create metafields for assigned subSKUs in an order
 * @param {object} session - Shopify session client
 * @param {string} orderId - Shopify order ID
 * @param {Array<{lineItemId: string, subSKUs: Array<string>}>} subSKUAssignments - Array of line item subSKU assignments
 */
async function createOrderSubSKUMetafields(session, orderId, subSKUAssignments) {
  try {
    const mutation = `
      mutation createOrderMetafields($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            key
            value
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    // Create one metafield for the entire order with all assignments
    const metafieldInput = {
      metafields: [
        {
          ownerId: orderId,
          namespace: "sku_tracking",
          key: "assigned_subskus",
          type: "json",
          value: JSON.stringify(
            subSKUAssignments.reduce((acc, assignment) => {
              acc[assignment.lineItemId] = assignment.subSKUs;
              return acc;
            }, {}),
          ),
        },
      ],
    };

    const response = await makeShopifyGraphQLRequest(session, mutation, metafieldInput);

    console.log("Created metafield for order:", {
      orderId,
      assignments: subSKUAssignments,
      response: response.data,
    });
  } catch (error) {
    console.error("Error creating order metafields:", error);
    throw error;
  }
}

/**
 * Process webhook payload and assign subSKUs
 * @param {object} session - Shopify session client
 * @param {object} payload - Webhook payload
 */
export async function processWebhookPayloadWithSKUs(session, payload) {
  try {
    // Check if this order has already been processed by looking up in the sheet
    const orderId = payload.id;
    const sheetData = await getSheet("Orders");
    
    // Get all values from the sheet and skip header row
    const values = (sheetData.values || []).slice(1);
    const orderIdColumnIndex = 1; // Order ID is the second column in orders sheet
    
    // Check if order already exists in sheet by checking the Order ID column
    const orderExists = values.some(row => row[orderIdColumnIndex] === orderId.toString());
    
    if (orderExists) {
      console.log(`⚠️ Order ${orderId} has already been processed, skipping...`);
      return {
        success: true,
        data: {
          skipped: true,
          reason: 'Order already processed'
        }
      };
    }

    // First process the order creation normally
    const orderResult = await processOrderCreation(session, payload);

    if (!orderResult.success) {
      throw new Error(orderResult.error);
    }

    // Get the assigned subSKUs for each line item
    const subSKUAssignments = orderResult.data
      .filter((result) => result.success)
      .map((result) => ({
        lineItemId: result.lineItemId,
        subSKUs: result.markedUnavailable,
      }));

    // Create metafields for the subSKU assignments
    await createOrderSubSKUMetafields(
      session,
      `gid://shopify/Order/${payload.id}`,
      subSKUAssignments,
    );

    // Get variant metafields for weight
    const lineItemsWithWeight = await Promise.all(payload.line_items.map(async (item) => {
      if (!item.variant_id) return item;

      // Get variant details including weight from REST API
      const variantResponse = await fetch(
        `https://${session.shop}/admin/api/2025-01/variants/${item.variant_id}.json?fields=weight_unit,weight`,
        {
          headers: {
            'X-Shopify-Access-Token': session.accessToken,
          },
        }
      );

      const variantData = await variantResponse.json();
      const variant = variantData.variant;
      console.log('variant', variant);
      // const query = `
      //   query getVariantMetafield($id: ID!) {
      //     productVariant(id: $id) {
      //       id
      //       metafield(namespace: "custom", key: "weight_in_gram") {
      //         value
      //       }
      //     }
      //   }
      // `;

      // const response = await makeShopifyGraphQLRequest(session, query, {
      //   id: `gid://shopify/ProductVariant/${item.variant_id}`
      // });

      // const weight = response.data?.productVariant?.metafield?.value;
      // Convert weight to grams based on weight unit
      let weightInGrams = null;
      if (variant?.weight && variant?.weight_unit) {
        switch (variant.weight_unit.toLowerCase()) {
          case 'kg':
            weightInGrams = variant.weight * 1000;
            break;
          case 'g':
            weightInGrams = variant.weight;
            break;
          case 'lb':
            weightInGrams = variant.weight * 453.592;
            break;
          case 'oz':
            weightInGrams = variant.weight * 28.3495;
            break;
        }
      }
      
      return {
        ...item,
        weight_in_gram: weightInGrams || null,
      };
    }));

    // Update payload with weight data
    payload.line_items = lineItemsWithWeight;
    // Use the existing processWebhookPayload function with subSKU assignments
    const processedOrders = processWebhookPayload(payload, subSKUAssignments);

    console.log('payload line items updated with weight>>>>', payload.line_items);
    await insertOrdersGroupedByDate("Orders", processedOrders);

    return {
      success: true,
      data: {
        order: orderResult,
        subSKUAssignments,
      },
    };
  } catch (error) {
    console.error("Error processing webhook payload with SKUs:", error);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Process order creation webhook with optimized parallel processing
 * @param {object} session - Shopify session client
 * @param {object} payload - Order webhook payload
 */
export async function processOrderCreation(session, payload) {
  try {
    console.log('🔍 Starting order creation process:', {
      orderId: payload.id,
      lineItems: payload.line_items.length
    });

    const processPromises = payload.line_items.map(async (item) => {
      const sku = item.sku;
      const quantity = item.quantity;

      console.log('📦 Processing line item:', {
        sku,
        quantity,
        lineItemId: item.id
      });

      if (!sku) {
        console.log('⚠️ Skipping line item - no SKU:', {
          lineItemId: item.id
        });
        return null;
      }

      const [shopifyData, ourData] = await Promise.all([
        makeShopifyGraphQLRequest(
          session,
          `
          query getInventoryItemBySku($sku: String!) {
            inventoryItems(first: 1, query: $sku) {
              edges {
                node {
                  id
                  sku
                  variant {
                    sku
                    inventoryQuantity
                  }
                }
              }
            }
          }
        `,
          { sku: `sku:${sku}` },
        ),
        getAvailableSKUs(sku),
      ]);

      console.log('📥 Received data:', {
        sku,
        hasShopifyData: !!shopifyData.data?.inventoryItems?.edges[0],
        hasOurData: !!ourData?.[0]
      });

      const inventoryItem = shopifyData.data.inventoryItems.edges[0]?.node;
      
      
      const shopifyQuantity = shopifyData.data.inventoryItems.edges
        .filter(edge => edge.node.sku === sku)
        .reduce((total, edge) => total + (edge.node.variant?.inventoryQuantity || 0), 0);

        console.log('inventoryItem', inventoryItem, "edges", shopifyData.data.inventoryItems.edges, "shopifyQuantity", shopifyQuantity);

      if (!ourData?.[0]) {
        console.error('❌ SKU not found in database:', {
          sku,
          lineItemId: item.id
        });
        return {
          sku,
          lineItemId: item.id,
          success: false,
          error: "SKU not found in database",
        };
      }

      // Get the first N available subSKUs (they are already sorted)
      const availableSubSKUs = ourData[0].availableSubSkus.slice(0, quantity);

      // Check if we have enough available subSKUs
      if (availableSubSKUs.length < quantity) {
        const toAdd = quantity - availableSubSKUs.length;
        
        console.log('➕ Not enough subSKUs available, adding more:', {
          sku,
          available: availableSubSKUs.length,
          needed: quantity,
          toAdd
        });

        // Get the last number used in subSKUs
        let lastNumber = 0;
        if (ourData[0].availableSubSkus.length > 0) {
          const lastSubSKU = ourData[0].availableSubSkus[ourData[0].availableSubSkus.length - 1];
          const lastNumberStr = lastSubSKU?.name?.split("-").pop() || "0";
          lastNumber = parseInt(lastNumberStr);
        }

        // Generate new subSKUs
        const newSubSKUs = Array.from({ length: toAdd }, (_, i) => ({
          name: `${sku}-${String(lastNumber + i + 1).padStart(4, "0")}`,
          status: "available",
        }));

        // Add the new subSKUs
        await db.SKU.update({
          where: { sku },
          data: {
            subSKU: {
              push: newSubSKUs,
            },
          },
        });

        // Get updated data and slice needed quantity
        const [updatedData] = await getAvailableSKUs(sku);
        const updatedAvailableSubSKUs = updatedData.availableSubSkus.slice(0, quantity);
        availableSubSKUs.push(...updatedAvailableSubSKUs.slice(availableSubSKUs.length));

        console.log('✅ Added new subSKUs when quantity is more than available: ', {
          sku,
          added: newSubSKUs.map(s => s.name),
          totalAvailableNow: availableSubSKUs.length
        });
      }

      console.log('🔄 Marking subSKUs as unavailable:', {
        sku,
        quantity,
        subSKUs: availableSubSKUs.map(s => s.name)
      });

      // Update all subSKUs in a single operation
      await updateSubSKUStatus(
        sku,
        availableSubSKUs.map(s => s.name),
        "unavailable"
      );

      const [updatedOurData] = await getAvailableSKUs(sku);
      const ourNewQuantity = updatedOurData.availableQuantity;
      console.log('updatedOurData after marking unavailable', updatedOurData);
      
      console.log('📊 Quantity comparison after marking unavailable:', {
        sku,
        ourNewQuantity,
        shopifyQuantity,
        difference: ourNewQuantity - shopifyQuantity
      });

      if (ourNewQuantity < shopifyQuantity) {
        const toAdd = shopifyQuantity - ourNewQuantity;
        console.log('➕ Adding new subSKUs to match Shopify:', {
          sku,
          toAdd,
          ourQuantity: ourNewQuantity,
          shopifyQuantity
        });
        await addSubSKUsToBase(sku, toAdd);
      }

      console.log('✅ Line item processed successfully:', {
        sku,
        lineItemId: item.id,
        quantity,
        markedUnavailable: availableSubSKUs.map(s => s.name),
        addedNew: ourNewQuantity < shopifyQuantity ? shopifyQuantity - ourNewQuantity : 0
      });

      return {
        sku,
        lineItemId: item.id,
        success: true,
        quantity,
        markedUnavailable: availableSubSKUs.map((sub) => sub.name),
        addedNew:
          ourNewQuantity < shopifyQuantity
            ? shopifyQuantity - ourNewQuantity
            : 0,
      };
    });

    const results = (await Promise.all(processPromises)).filter(
      (result) => result !== null,
    );

    console.log('✅ Order creation completed:', {
      orderId: payload.id,
      processedItems: results.length,
      successfulItems: results.filter(r => r.success).length,
      failedItems: results.filter(r => !r.success).length
    });

    return {
      success: true,
      data: results,
    };
  } catch (error) {
    console.error('❌ Error processing order creation:', {
      error: error.message,
      stack: error.stack,
      orderId: payload.id
    });
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Update multiple subSKU statuses in parallel
 * @param {string} baseSku - The base SKU
 * @param {Array<{name: string, status: string}>} updates - Array of updates
 * @returns {Promise<boolean>}
 */
export async function updateMultipleSubSKUStatus(baseSku, updates) {
  try {
    const sku = await db.SKU.findUnique({
      where: { sku: baseSku },
    });

    if (!sku) {
      throw new Error(`SKU ${baseSku} not found`);
    }

    const updatedSubSKUs = sku.subSKU.map((subSku) => {
      const update = updates.find((u) => u.name === subSku.name);
      if (update) {
        return { ...subSku, status: update.status };
      }
      return subSku;
    });

    await db.SKU.update({
      where: { sku: baseSku },
      data: { subSKU: updatedSubSKUs },
    });

    return true;
  } catch (error) {
    console.error(
      `Error updating multiple subSKU statuses for ${baseSku}:`,
      error,
    );
    throw error;
  }
}

/**
 * Get available quantities for multiple SKUs in parallel
 * @param {Array<string>} skus - Array of SKUs to check
 * @returns {Promise<Array>}
 */
export async function getMultipleAvailableSKUs(skus) {
  try {
    const uniqueSkus = [...new Set(skus)]; // Remove duplicates
    const results = await Promise.all(
      uniqueSkus.map(async (sku) => {
        try {
          const [skuData] = await getAvailableSKUs(sku);
          return {
            sku,
            success: true,
            data: skuData,
          };
        } catch (error) {
          return {
            sku,
            success: false,
            error: error.message,
          };
        }
      }),
    );

    return results;
  } catch (error) {
    console.error("Error fetching multiple SKUs:", error);
    throw error;
  }
}

/**
 * Process order cancellation or return approval
 * @param {object} session - Shopify session client
 * @param {object} payload - Order webhook payload
 * @param {string} type - Type of event ('cancelled' or 'return')
 */
export async function processOrderCancellation(session, payload, type = "cancelled") {
  try {
    console.log('🔍 Starting order cancellation process:', {
      orderId: payload.id,
      type,
      lineItems: payload.line_items.length
    });

    // Get the order to find the assigned subSKUs
    const orderQuery = `
      query getOrder($id: ID!) {
        order(id: $id) {
          id
          name
          email
          phone
          customer {
            firstName
            lastName
            email
            phone
          }
          metafields(first: 10, namespace: "sku_tracking") {
            edges {
              node {
                key
                value
              }
            }
          }
          lineItems(first: 50) {
            nodes {
              id
              sku
              quantity
              title
              variantTitle
              variant {
                id
                title
                inventoryItem {
                  id
                  sku
                }
              }
            }
          }
        }
      }
    `;

    const orderData = await makeShopifyGraphQLRequest(
      session,
      orderQuery,
      {
        id: `gid://shopify/Order/${payload.id}`,
      }
    );

    const order = orderData.data.order;
    if (!order) {
      throw new Error(`Order ${payload.id} not found`);
    }

    // Get the assigned subSKUs from metafields
    const assignedSubSKUsMetafield = order.metafields.edges.find(
      edge => edge.node.key === 'assigned_subskus'
    );

    if (!assignedSubSKUsMetafield) {
      console.log('⚠️ No assigned subSKUs found for order:', payload.id);
      return {
        success: true,
        data: {
          skipped: true,
          reason: 'No assigned subSKUs found'
        }
      };
    }

    const assignedSubSKUs = JSON.parse(assignedSubSKUsMetafield.node.value);
    const updatedAssignedSubSKUs = { ...assignedSubSKUs };

    const processPromises = payload.line_items.map(async (item) => {
      const sku = item.sku;
      const quantity = item.quantity;
      const lineItemId = item.id;

      console.log('📦 Processing line item for cancellation:', {
        sku,
        quantity,
        lineItemId
      });

      if (!sku) {
        console.log('⚠️ Skipping line item - no SKU:', {
          lineItemId
        });
        return null;
      }

      // Find the line item in the order
      const lineItem = order.lineItems.nodes.find(
        node => {
          // Extract numeric ID from GID if present
          const nodeId = node.id.includes('gid://') 
            ? node.id.split('/').pop() 
            : node.id;
          return nodeId === lineItemId.toString();
        }
      );

      if (!lineItem?.variant?.inventoryItem?.id) {
        console.log('⚠️ No inventory item ID found for line item:', lineItemId);
        return null;
      }

      const inventoryItemId = lineItem.variant.inventoryItem.id;

      // Get the assigned subSKUs for this line item using line item ID
      const lineItemSubSKUs = assignedSubSKUs[lineItemId] || [];
      
      console.log('🔍 Checking assigned subSKUs:', {
        lineItemId,
        assignedSubSKUsCount: lineItemSubSKUs.length,
        subSKUs: lineItemSubSKUs,
        availableKeys: Object.keys(assignedSubSKUs),
        assignedSubSKUs: JSON.stringify(assignedSubSKUs)
      });

      if (lineItemSubSKUs.length == 0) {
        console.log('⚠️ No subSKUs assigned to line item cancelled:', {
          lineItemId,
          availableInventoryItems: Object.keys(assignedSubSKUs),
          assignedSubSKUs: JSON.stringify(assignedSubSKUs)
        });
        return null;
      }

      // Get the subSKUs to mark as available (last N subSKUs)
      const subSKUsToMarkAvailable = lineItemSubSKUs.slice(-quantity);
      
      // Update the assigned subSKUs in our local copy
      updatedAssignedSubSKUs[lineItemId] = lineItemSubSKUs.slice(0, -quantity);

      console.log('🔄 Marking subSKUs as available:', {
        sku,
        quantity,
        subSKUs: subSKUsToMarkAvailable
      });

      // Update the subSKUs status
      await updateSubSKUStatus(
        sku,
        subSKUsToMarkAvailable,
        "available"
      );

      // Get updated quantities
      const [updatedSkuData] = await getAvailableSKUs(sku);
      const ourNewQuantity = updatedSkuData.availableQuantity;

      // Get Shopify quantity
      const shopifyData = await makeShopifyGraphQLRequest(
        session,
        `
        query getInventoryItemBySku($sku: String!) {
          inventoryItems(first: 1, query: $sku) {
            edges {
              node {
                id
                sku
                variant {
                  sku
                  inventoryQuantity
                }
              }
            }
          }
        }
      `,
        { sku: `sku:${sku}` }
      );

      const shopifyQuantity = shopifyData.data.inventoryItems.edges
        .filter(edge => edge.node.sku === sku)
        .reduce((total, edge) => total + (edge.node.variant?.inventoryQuantity || 0), 0);

      console.log('📊 Quantity comparison after marking available:', {
        sku,
        ourNewQuantity,
        shopifyQuantity,
        difference: ourNewQuantity - shopifyQuantity
      });

      // If our quantity is now greater than Shopify's, remove excess subSKUs
      if (ourNewQuantity > shopifyQuantity) {
        const toRemove = ourNewQuantity - shopifyQuantity;
        console.log('➖ Removing excess subSKUs:', {
          sku,
          toRemove,
          ourQuantity: ourNewQuantity,
          shopifyQuantity
        });
        await removeSubSKUsByQuantity(sku, toRemove);
      }

      return {
        sku,
        lineItemId,
        inventoryItemId,
        success: true,
        type,
        quantity,
        markedAvailable: subSKUsToMarkAvailable,
        removedExcess: ourNewQuantity > shopifyQuantity ? ourNewQuantity - shopifyQuantity : 0,
        finalQuantities: {
          shopify: shopifyQuantity,
          ourSystem: ourNewQuantity
        }
      };
    });

    const results = (await Promise.all(processPromises)).filter(
      result => result !== null
    );

    console.log('🔍 order cancellation results:', results);

    // Prepare sheet data for cancelled items
    const sheetData = [];
    for (const result of results) {
      if (!result.success) continue;
      const { sku, lineItemId, markedAvailable } = result;
      // Find the line item in the order
      const lineItem = order.lineItems.nodes.find(
        node => {
          const nodeId = node.id.includes('gid://') 
            ? node.id.split('/').pop() 
            : node.id;
          return nodeId === lineItemId.toString();
        }
      );
      if (!lineItem) continue;

      // Get variant weight
      let weightInGrams = null;
      try {
        const variantResponse = await fetch(
          `https://${session.shop}/admin/api/2025-01/variants/${lineItem.variant.id.split('/').pop()}.json?fields=weight_unit,weight`,
          {
            headers: {
              'X-Shopify-Access-Token': session.accessToken,
            },
          }
        );

        const variantData = await variantResponse.json();
        const variant = variantData.variant;

        if (variant?.weight && variant?.weight_unit) {
          switch (variant.weight_unit.toLowerCase()) {
            case 'kg':
              weightInGrams = variant.weight * 1000;
              break;
            case 'g':
              weightInGrams = variant.weight;
              break;
            case 'lb':
              weightInGrams = variant.weight * 453.592;
              break;
            case 'oz':
              weightInGrams = variant.weight * 28.3495;
              break;
          }
        }
      } catch (error) {
        console.error(`Error fetching variant weight for ${sku}:`, error);
      }
      // Add to sheet data for each subSKU being returned
      const currentDate = order.createdAt ? new Date(order.createdAt) : new Date();
      const timeParisZone = currentDate.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris' });
      markedAvailable.forEach((subSkuName) => {
        sheetData.push([
          "", // Date
          timeParisZone, // Time (Paris Time Zone)
          order.name, // Invoice Number
          lineItem.title, // Item Title
          sku, // SKU
          subSkuName, // Sub-SKU
          lineItem.variantTitle || "", // Variant
          "", // Selected Size
          weightInGrams || "", // Output Weight
          "Order Cancelled", // Output Reason
          "", // Free Handwritten Note
          `${order.customer?.firstName || ""} ${order.customer?.lastName || ""}`.trim(), // Customer Name
          order.customer?.email || "", // Email
          order.customer?.phone || "", // Telephone
          "", // Attachment pdf - jpg
          "", // Supplier Name
          "", // Supplier Address
          "", // ID session staff
          `Order Cancelled ID: ${payload.id}`, // Note
        ]);
      });
    }

    // Update the metafields with the remaining assigned subSKUs
    const mutation = `
      mutation createOrderMetafields($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            key
            value
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const metafieldInput = {
      metafields: [
        {
          ownerId: `gid://shopify/Order/${payload.id}`,
          namespace: "sku_tracking",
          key: "assigned_subskus",
          type: "json",
          value: JSON.stringify(updatedAssignedSubSKUs)
        }
      ]
    };

    await makeShopifyGraphQLRequest(session, mutation, metafieldInput);

    // Prepend data to Google Sheet
    if (sheetData.length > 0) {
      console.log(`📊 Prepending ${sheetData.length} rows to Orders sheet for order cancelled ${payload.id}`);
      
      const authClient = await auth.getClient();
      const sheets = google.sheets({ version: "v4", auth: authClient });
      
      // Use the new prepend function
      await prependDataToSheet("Orders", sheetData, 3);

      // Apply dark red background color for cancelled orders
      const formatRequests = [];
      let currentRow = 3; // Start from row 3 (after header and date row)

      for (const row of sheetData) {
        formatRequests.push({
          repeatCell: {
            range: {
              sheetId: await getSheetId(sheets, "Orders"),
              startRowIndex: currentRow - 1,
              endRowIndex: currentRow,
              startColumnIndex: 0,
              endColumnIndex: 19, // All columns
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.8, green: 0.2, blue: 0.2 }, // Dark red
                textFormat: { 
                  foregroundColor: { red: 1, green: 1, blue: 1 } // White text
                }
              },
            },
            fields: "userEnteredFormat(backgroundColor,textFormat)",
          },
        });
        currentRow++;
      }

      // Apply formatting
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        requestBody: { requests: formatRequests },
      });
      console.log(`✅ Applied dark red background colors to ${formatRequests.length} rows`);

      console.log(`✅ Successfully prepended ${sheetData.length} rows to Orders sheet`);
    }

    console.log('✅ Order cancellation completed:', {
      orderId: payload.id,
      type,
      processedItems: results.length,
      successfulItems: results.filter(r => r.success).length,
      failedItems: results.filter(r => !r.success).length
    });

    return {
      success: true,
      data: results
    };
  } catch (error) {
    console.error('❌ Error processing order cancellation:', {
      error: error.message,
      stack: error.stack,
      orderId: payload.id,
      type
    });
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Process refund webhook
 * @param {object} session - Shopify session client
 * @param {object} payload - Refund webhook payload
 */
export async function processRefund(session, payload) {
  try {
    console.log('🔍 Starting refund process:', {
      refundId: payload.id,
      orderId: payload.order_id,
      refundLineItems: payload.refund_line_items?.length || 0
    });

    // Get the order to find the assigned subSKUs
    const orderQuery = `
      query getOrder($id: ID!) {
        order(id: $id) {
          id
          name
          email
          phone
          customer {
            firstName
            lastName
            email
            phone
          }
          metafields(first: 10, namespace: "sku_tracking") {
            edges {
              node {
                key
                value
              }
            }
          }
          lineItems(first: 50) {
            nodes {
              id
              sku
              quantity
              title
              variantTitle
              variant {
                id
                title
                inventoryItem {
                  id
                  sku
                }
              }
            }
          }
        }
      }
    `;

    const orderData = await makeShopifyGraphQLRequest(
      session,
      orderQuery,
      {
        id: `gid://shopify/Order/${payload.order_id}`,
      }
    );

    console.log('📥 Order data received:', {
      hasOrder: !!orderData.data?.order,
      lineItemsCount: orderData.data?.order?.lineItems?.nodes?.length || 0,
      metafieldsCount: orderData.data?.order?.metafields?.edges?.length || 0
    });

    const order = orderData.data.order;
    if (!order) {
      throw new Error(`Order ${payload.order_id} not found`);
    }

    // Get the assigned subSKUs from metafields
    const assignedSubSKUsMetafield = order.metafields.edges.find(
      edge => edge.node.key === 'assigned_subskus'
    );

    console.log('🔍 Checking metafields:', {
      hasMetafield: !!assignedSubSKUsMetafield,
      metafieldKey: assignedSubSKUsMetafield?.node?.key,
      metafieldValue: assignedSubSKUsMetafield?.node?.value ? 'exists' : 'missing'
    });

    if (!assignedSubSKUsMetafield) {
      console.log('⚠️ No assigned subSKUs found for order:', payload.order_id);
      return {
        success: true,
        data: {
          skipped: true,
          reason: 'No assigned subSKUs found'
        }
      };
    }

    const assignedSubSKUs = JSON.parse(assignedSubSKUsMetafield.node.value);
    const updatedAssignedSubSKUs = { ...assignedSubSKUs };

    console.log('📊 Current assigned subSKUs:', {
      inventoryItemIds: Object.keys(assignedSubSKUs),
      totalAssignedSubSKUs: Object.values(assignedSubSKUs).reduce((acc, curr) => acc + curr.length, 0)
    });

    // Process each refund line item
    const processPromises = payload.refund_line_items.map(async (refundItem) => {
      const lineItemId = refundItem.line_item_id;
      const quantity = refundItem.quantity;

      console.log('🔄 Processing refund line item:', {
        lineItemId,
        quantity,
        refundItemId: refundItem.id,
        lineItems: order.lineItems.nodes.map(item => ({
          id: item.id,
          sku: item.sku
        }))
      });

      // Find the line item in the order
      const lineItem = order.lineItems.nodes.find(
        node => {
          // Extract numeric ID from GID if present
          const nodeId = node.id.includes('gid://') 
            ? node.id.split('/').pop() 
            : node.id;
          return nodeId === lineItemId.toString();
        }
      );

      console.log('🔍 Line item lookup:', {
        lineItemId,
        found: !!lineItem,
        hasVariant: !!lineItem?.variant,
        hasInventoryItem: !!lineItem?.variant?.inventoryItem,
        lineItemData: lineItem ? {
          id: lineItem.id,
          sku: lineItem.sku,
          quantity: lineItem.quantity,
          inventoryItemId: lineItem.variant?.inventoryItem?.id
        } : null
      });

      if (!lineItem) {
        console.log('⚠️ Line item not found:', {
          lineItemId,
          availableLineItems: order.lineItems.nodes.map(item => ({
            id: item.id,
            sku: item.sku
          }))
        });
        return null;
      }

      const sku = lineItem.sku;
      if (!sku) {
        console.log('⚠️ No SKU found for line item:', {
          lineItemId,
          lineItemData: {
            id: lineItem.id,
            quantity: lineItem.quantity
          }
        });
        return null;
      }

      if (!lineItem.variant?.inventoryItem?.id) {
        console.log('⚠️ No inventory item ID found for line item:', {
          lineItemId,
          sku,
          hasVariant: !!lineItem.variant,
          hasInventoryItem: !!lineItem.variant?.inventoryItem,
          variantData: lineItem.variant ? {
            inventoryItemId: lineItem.variant.inventoryItem?.id,
            inventoryItemSku: lineItem.variant.inventoryItem?.sku
          } : null
        });
        return null;
      }

      const inventoryItemId = lineItem.variant.inventoryItem.id;

      console.log('📦 Found inventory item:', {
        lineItemId,
        sku,
        inventoryItemId,
        inventoryItemSku: lineItem.variant.inventoryItem.sku
      });

      // Get the assigned subSKUs for this line item using line item ID
      const lineItemSubSKUs = assignedSubSKUs[lineItemId] || [];
      
      console.log('🔍 Checking assigned subSKUs:', {
        lineItemId,
        assignedSubSKUsCount: lineItemSubSKUs.length,
        subSKUs: lineItemSubSKUs,
        availableKeys: Object.keys(assignedSubSKUs),
        assignedSubSKUs: JSON.stringify(assignedSubSKUs)
      });

      if (lineItemSubSKUs.length == 0) {
        console.log('⚠️ No subSKUs assigned to line item refund:', {
          lineItemId,
          availableInventoryItems: Object.keys(assignedSubSKUs),
          assignedSubSKUs: JSON.stringify(assignedSubSKUs)
        });
        return null;
      }

      // Get the subSKUs to mark as available (last N subSKUs)
      const subSKUsToMarkAvailable = lineItemSubSKUs.slice(-quantity);
      
      console.log('🔄 Preparing to mark subSKUs as available:', {
        inventoryItemId,
        quantity,
        subSKUsToMarkAvailable,
        remainingSubSKUs: lineItemSubSKUs.slice(0, -quantity)
      });

      // Update the assigned subSKUs in our local copy
      updatedAssignedSubSKUs[lineItemId] = lineItemSubSKUs.slice(0, -quantity);

      console.log('🔄 Marking subSKUs as available:', {
        sku,
        quantity,
        subSKUs: subSKUsToMarkAvailable
      });

      // Update the subSKUs status
      await updateSubSKUStatus(
        sku,
        subSKUsToMarkAvailable,
        "available"
      );

      // Get updated quantities
      const [updatedSkuData] = await getAvailableSKUs(sku);
      const ourNewQuantity = updatedSkuData.availableQuantity;

      console.log('📊 Updated SKU data:', {
        sku,
        ourNewQuantity,
        totalQuantity: updatedSkuData.totalQuantity,
        availableSubSKUs: updatedSkuData.availableSubSkus
      });

      // Get Shopify quantity
      const shopifyData = await makeShopifyGraphQLRequest(
        session,
        `
        query getInventoryItemBySku($sku: String!) {
          inventoryItems(first: 1, query: $sku) {
            edges {
              node {
                id
                sku
                variant {
                  sku
                  inventoryQuantity
                }
              }
            }
          }
        }
      `,
        { sku: `sku:${sku}` }
      );

      const shopifyQuantity = shopifyData.data.inventoryItems.edges
        .filter(edge => edge.node.sku === sku)
        .reduce((total, edge) => total + (edge.node.variant?.inventoryQuantity || 0), 0);

      console.log('📊 Quantity comparison after marking available:', {
        sku,
        ourNewQuantity,
        shopifyQuantity,
        difference: ourNewQuantity - shopifyQuantity
      });

      // If our quantity is now greater than Shopify's, remove excess subSKUs
      if (ourNewQuantity > shopifyQuantity) {
        const toRemove = ourNewQuantity - shopifyQuantity;
        console.log('➖ Removing excess subSKUs:', {
          sku,
          toRemove,
          ourQuantity: ourNewQuantity,
          shopifyQuantity
        });
        await removeSubSKUsByQuantity(sku, toRemove);
      }

      return {
        sku,
        lineItemId,
        inventoryItemId,
        success: true,
        quantity,
        markedAvailable: subSKUsToMarkAvailable,
        removedExcess: ourNewQuantity > shopifyQuantity ? ourNewQuantity - shopifyQuantity : 0
      };
    });

    const results = (await Promise.all(processPromises)).filter(
      result => result !== null
    );

    console.log('📊 Processing results:', {
      totalItems: payload.refund_line_items.length,
      processedItems: results.length,
      successfulItems: results.filter(r => r.success).length,
      results: results.map(r => ({
        sku: r.sku,
        lineItemId: r.lineItemId,
        inventoryItemId: r.inventoryItemId,
        quantity: r.quantity
      }))
    });

    // Update the metafields with the remaining assigned subSKUs
    const mutation = `
      mutation createOrderMetafields($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            key
            value
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const metafieldInput = {
      metafields: [
        {
          ownerId: `gid://shopify/Order/${payload.order_id}`,
          namespace: "sku_tracking",
          key: "assigned_subskus",
          type: "json",
          value: JSON.stringify(updatedAssignedSubSKUs)
        }
      ]
    };

    console.log('🔄 Updating metafields:', {
      orderId: payload.order_id,
      updatedInventoryItems: Object.keys(updatedAssignedSubSKUs),
      totalRemainingSubSKUs: Object.values(updatedAssignedSubSKUs).reduce((acc, curr) => acc + curr.length, 0)
    });

    await makeShopifyGraphQLRequest(session, mutation, metafieldInput);

    // Prepare sheet data for refunded items
    const sheetData = [];
    for (const result of results) {
      if (!result.success) continue;
      const { sku, lineItemId, markedAvailable } = result;
      
      // Find the line item in the order
      const lineItem = order.lineItems.nodes.find(
        node => {
          const nodeId = node.id.includes('gid://') 
            ? node.id.split('/').pop() 
            : node.id;
          return nodeId === lineItemId.toString();
        }
      );
      if (!lineItem) continue;

      // Get variant weight
      let weightInGrams = null;
      try {
        const variantResponse = await fetch(
          `https://${session.shop}/admin/api/2025-01/variants/${lineItem.variant.id.split('/').pop()}.json?fields=weight_unit,weight`,
          {
            headers: {
              'X-Shopify-Access-Token': session.accessToken,
            },
          }
        );

        const variantData = await variantResponse.json();
        const variant = variantData.variant;

        if (variant?.weight && variant?.weight_unit) {
          switch (variant.weight_unit.toLowerCase()) {
            case 'kg':
              weightInGrams = variant.weight * 1000;
              break;
            case 'g':
              weightInGrams = variant.weight;
              break;
            case 'lb':
              weightInGrams = variant.weight * 453.592;
              break;
            case 'oz':
              weightInGrams = variant.weight * 28.3495;
              break;
          }
        }
      } catch (error) {
        console.error(`Error fetching variant weight for ${sku}:`, error);
      }

      // Add to sheet data for each subSKU being returned
      const currentDate = new Date();
      const timeParisZone = currentDate.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris' });
      
      markedAvailable.forEach((subSkuName) => {
        sheetData.push([
          "", // Date
          timeParisZone, // Time (Paris Time Zone)
          order.name, // Invoice Number
          lineItem.title, // Item Title
          sku, // SKU
          subSkuName, // Sub-SKU
          lineItem.variantTitle || "", // Variant
          "", // Selected Size
          weightInGrams || "", // Output Weight
          "Order Refunded", // Output Reason
          "", // Free Handwritten Note
          `${order.customer?.firstName || ""} ${order.customer?.lastName || ""}`.trim(), // Customer Name
          order.customer?.email || "", // Email
          order.customer?.phone || "", // Telephone
          "", // Attachment pdf - jpg
          "", // Supplier Name
          "", // Supplier Address
          "", // ID session staff
          `Refund ID: ${payload.id}`, // Note
        ]);
      });
    }

    // Prepend data to Google Sheet
    if (sheetData.length > 0) {
      console.log(`📊 Prepending ${sheetData.length} rows to Orders sheet for refund ${payload.id}`);
      
      const authClient = await auth.getClient();
      const sheets = google.sheets({ version: "v4", auth: authClient });
      
      // Use the new prepend function
      await prependDataToSheet("Orders", sheetData, 3);

      // Apply orange background color for refunded orders
      const formatRequests = [];
      let currentRow = 3; // Start from row 3 (after header and date row)

      for (const row of sheetData) {
        formatRequests.push({
          repeatCell: {
            range: {
              sheetId: await getSheetId(sheets, "Orders"),
              startRowIndex: currentRow - 1,
              endRowIndex: currentRow,
              startColumnIndex: 0,
              endColumnIndex: 19, // All columns
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 1.0, green: 0.6, blue: 0.2 }, // Orange
                textFormat: { 
                  foregroundColor: { red: 1, green: 1, blue: 1 } // White text for better contrast with orange background
                }
              },
            },
            fields: "userEnteredFormat(backgroundColor,textFormat)",
          },
        });
        currentRow++;
      }

      // Apply formatting
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        requestBody: { requests: formatRequests },
      });
      console.log(`✅ Applied orange background colors to ${formatRequests.length} rows`);

      console.log(`✅ Successfully prepended ${sheetData.length} rows to Orders sheet`);
    }

    console.log('✅ Refund processing completed:', {
      refundId: payload.id,
      orderId: payload.order_id,
      processedItems: results.length,
      successfulItems: results.filter(r => r.success).length,
      sheetRowsAdded: sheetData.length
    });

    return {
      success: true,
      data: results
    };
  } catch (error) {
    console.error('❌ Error processing refund:', {
      error: error.message,
      stack: error.stack,
      refundId: payload.id,
      orderId: payload.order_id
    });
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Get the number of variants that share the same SKU in Shopify
 * @param {object} session - Shopify session client
 * @param {string} sku - The SKU to check
 * @returns {Promise<number>} - Returns the number of variants sharing the SKU
 */
export async function getVariantLengthBySKU(session, sku) {
  try {
    const query = `
      query getVariantsBySKU($sku: String!) {
        inventoryItems(first: 1, query: $sku) {
          edges {
            node {
              id
              sku
              variant {
                sku
                product {
                  variants(first: 50) {
                    edges {
                      node {
                        sku
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const data = await makeShopifyGraphQLRequest(session, query, { sku: `sku:${sku}` });
    
    // Get all variants from the product
    const variants = data.data.inventoryItems.edges[0]?.node?.variant?.product?.variants?.edges || [];
    
    // Count variants that share the same SKU
    const variantCount = variants.filter(edge => edge.node.sku === sku).length;
    
    return variantCount;
  } catch (error) {
    console.error(`Error getting variant length for SKU ${sku}:`, error);
    throw error;
  }
}

/**
 * Save or update product data in the database
 * @param {object} payload - Product webhook payload
 * @param {object} options - Optional parameters for weight data
 * @returns {Promise<Object>} - Returns the saved/updated product object
 */
export async function saveProductToDatabase(payload, options = {}) {
  try {
    const variants = payload.variants || [];
    const processedVariants = [];

    for (const variant of variants) {
      // Use weight data from options if provided (for product updates where we fetch weight separately)
      // Otherwise use weight from payload if available
      let weightInGram = 0;
      if (options.variantWeights && options.variantWeights[variant.id]) {
        weightInGram = options.variantWeights[variant.id];
      } else if (variant.weight_in_gram) {
        weightInGram = variant.weight_in_gram;
      }

      processedVariants.push({
        title: variant.title || "",
        weightInGram: weightInGram,
        quantity: variant.inventory_quantity || 0,
        sku: variant.sku || ""
      });
    }

    // Upsert product data
    const product = await db.Product.upsert({
      where: { productId: payload.id.toString() },
      update: {
        title: payload.title,
        vendor: payload.vendor,
        variants: processedVariants,
        updatedAt: new Date()
      },
      create: {
        productId: payload.id.toString(),
        title: payload.title,
        vendor: payload.vendor,
        variants: processedVariants
      }
    });

    console.log(`✅ Product ${payload.title} saved to database`);
    return product;
  } catch (error) {
    console.error("Error saving product to database:", error);
    throw error;
  }
}

/**
 * Get product data from database
 * @param {string} productId - Shopify product ID
 * @returns {Promise<Object|null>} - Returns the product object or null
 */
export async function getProductFromDatabase(productId) {
  try {
    const product = await db.Product.findUnique({
      where: { productId: productId.toString() }
    });
    return product;
  } catch (error) {
    console.error("Error getting product from database:", error);
    return null;
  }
}

/**
 * Process product update webhook - append new subSKUs when inventory increases and when weight is updated
 * @param {object} session - Shopify session client
 * @param {object} payload - Product update webhook payload
 */
export async function processProductUpdate(session, payload) {
  try {
    console.log('🔄 Processing product update:', {
      productId: payload.id,
      title: payload.title
    });

    const variants = payload.variants || [];
    const results = [];
    const sheetData = [];
    let variantWeights = {}; // Store weight data for database update

    // Get existing product data from database
    const existingProduct = await getProductFromDatabase(payload.id);
    
    if (!existingProduct) {
      console.log('⚠️ Product not found in database, treating as new product');
      // For new products, we'll handle it here instead of calling processProductCreate
      // to ensure we only add the new subSKUs, not all of them
    }

    // First ensure sheet has proper headers
    await ensureSheetHasHeader();

    // Format the date from the payload
    const productDate = new Date(payload.updated_at || payload.created_at);
    const timeParisZone = productDate.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris' });

    for (const variant of payload.variants || []) {
      const sku = variant.sku;
      if (!sku) continue;

      // Get variant weight using REST API
      let weightInGrams = null;
      try {
        const variantResponse = await fetch(
          `https://${session.shop}/admin/api/2025-01/variants/${variant.id}.json?fields=weight_unit,weight`,
          {
            headers: {
              'X-Shopify-Access-Token': session.accessToken,
            },
          }
        );

        const variantData = await variantResponse.json();
        const variantWeight = variantData.variant;

        // Convert weight to grams based on weight unit
        if (variantWeight?.weight && variantWeight?.weight_unit) {
          switch (variantWeight.weight_unit.toLowerCase()) {
            case 'kg':
              weightInGrams = variantWeight.weight * 1000;
              break;
            case 'g':
              weightInGrams = variantWeight.weight;
              break;
            case 'lb':
              weightInGrams = variantWeight.weight * 453.592;
              break;
            case 'oz':
              weightInGrams = variantWeight.weight * 28.3495;
              break;
          }
        }
      } catch (error) {
        console.error(`Error fetching variant weight for ${sku}:`, error);
      }

      // Store weight data for database update
      variantWeights[variant.id] = weightInGrams || 0;

      // Find existing variant data from the product database
      const existingVariant = existingProduct ? existingProduct.variants.find(v => v.sku === sku) : null;
      const newQuantity = variant.inventory_quantity || 0;
      const oldQuantity = existingVariant ? existingVariant.quantity : 0;
      const oldWeight = existingVariant ? existingVariant.weightInGram : 0;

      console.log('📊 Comparison for SKU:', {
        sku,
        oldQuantity,
        newQuantity,
        oldWeight,
        newWeight: weightInGrams,
        quantityDifference: newQuantity - oldQuantity,
        weightDifference: weightInGrams - oldWeight,
        isNewProduct: !existingProduct
      });

      let shouldAddToSheet = false;
      let reason = "";

      // Check for inventory increase
      if (!existingProduct || newQuantity > oldQuantity) {
        const quantityIncrease = existingProduct ? (newQuantity - oldQuantity) : newQuantity;
        
        console.log('➕ Processing inventory increase:', {
          sku,
          increase: quantityIncrease,
          from: oldQuantity,
          to: newQuantity,
          isNewProduct: !existingProduct
        });

        // Get the last subSKU number (regardless of status) to determine starting point
        const fullSkuData = await db.SKU.findUnique({
          where: { sku }
        });
        let startNumber = 1; // Default start number

        if (fullSkuData && fullSkuData.subSKU && fullSkuData.subSKU.length > 0) {
          // Get the last subSKU number and start from the next number
          const lastSubSKU = fullSkuData.subSKU[fullSkuData.subSKU.length - 1];
          const lastNumberStr = lastSubSKU?.name?.split("-").pop() || "0";
          startNumber = parseInt(lastNumberStr) + 1; // Start from the next number after the last subSKU
        } else if (!fullSkuData) {
          // SKU not found in database - this is a new SKU
          console.log('🆕 SKU not found in database, treating as new SKU:', {
            sku,
            startNumber: 1
          });
        }

        console.log('📊 Current inventory state:', {
          sku,
          startNumber,
          newQuantity,
          availableSubSKUs: skuData?.availableSubSkus?.length || 0
        });

        // Generate new subSKU names starting from the last available number
        const newSubSKUNames = [];
        for (let i = 0; i < quantityIncrease; i++) {
          const subSKUNumber = String(startNumber + i).padStart(4, "0");
          newSubSKUNames.push(`${sku}-${subSKUNumber}`);
        }

        console.log('🆕 Generated new subSKU names:', {
          sku,
          startNumber,
          newQuantity,
          newSubSKUNames,
          count: newSubSKUNames.length
        });

        results.push({
          sku,
          success: true,
          quantityIncrease: newQuantity,
          newSubSKUs: newSubSKUNames
        });

        // Add all the new subSKUs to the sheet
        newSubSKUNames.forEach((subSkuName) => {
          sheetData.push([
            "", // Empty date cell since we have the date header
            timeParisZone, // Time (Paris Time Zone)
            payload.title, // Item Title
            sku, // SKU
            subSkuName, // Sub-SKU
            variant.title || "", // Variant
            weightInGrams || "", // Input Weight (in grams)
            "Inventory Update", // Input Reason
            "", // Free Handwritten Note
            payload.vendor, // "Supplier Name"
            "", // "Supplier Address"
          ]);
        });

        shouldAddToSheet = true;
        reason = "Inventory Update";
      }

      // Check for weight change (only if weight actually changed and we have existing data)
      // COMMENTED OUT - Weight update process disabled
      /*
      if (existingProduct && existingVariant && weightInGrams !== null && weightInGrams !== oldWeight) {
        console.log('⚖️ Processing weight change:', {
          sku,
          oldWeight,
          newWeight: weightInGrams,
          difference: weightInGrams - oldWeight
        });

        // Get current available subSKUs for this SKU
        const [skuData] = await getAvailableSKUs(sku);
        if (skuData && skuData.availableSubSkus.length > 0) {
          // Add each available subSKU to the sheet with weight update reason
          skuData.availableSubSkus.forEach((subSku) => {
            sheetData.push([
              "", // Empty date cell since we have the date header
              timeParisZone, // Time (Paris Time Zone)
              payload.title, // Item Title
              sku, // SKU
              subSku.name, // Sub-SKU
              variant.title || "", // Variant
              weightInGrams || "", // Input Weight (in grams)
              "Weight Update", // Input Reason
              "", // Free Handwritten Note
              payload.vendor, // "Supplier Name"
              "", // "Supplier Address"
            ]);
          });

          shouldAddToSheet = true;
          reason = "Weight Update";

          results.push({
            sku,
            success: true,
            weightChange: {
              oldWeight,
              newWeight: weightInGrams,
              subSKUsUpdated: skuData.availableSubSkus.length
            }
          });
        }
      }
      */

      if (!shouldAddToSheet) {
        console.log('ℹ️ No changes detected for SKU:', {
          sku,
          oldQuantity,
          newQuantity,
          oldWeight,
          newWeight: weightInGrams
        });
      }
    }

    // Update Google Sheet with new data only
    if (sheetData.length > 0) {
      console.log(`Adding ${sheetData.length} new rows to Google Sheet for product update ${payload.title}`);
      
      // Use the new prepend function
      await prependDataToSheet("Inventory Updates", sheetData, 3);

      console.log(`✅ Successfully prepended ${sheetData.length} new rows to Google Sheet`);
    }

    // Update product data in database with weight information
    await saveProductToDatabase(payload, { variantWeights });

    return {
      success: true,
      data: {
        results,
        sheetRowsAdded: sheetData.length,
      },
    };
  } catch (error) {
    console.error("Error processing product update:", error);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Process order edit webhook
 * @param {object} session - Shopify session client
 * @param {object} payload - Order edit webhook payload
 */
export async function processOrderEdit(session, payload) {
  try {
    console.log('🔍 Starting order edit process:', {
      orderEditId: payload.order_edit.id,
      orderId: payload.order_edit.order_id,
      additions: payload.order_edit.line_items.additions.length,
      removals: payload.order_edit.line_items.removals.length
    });

    // Get the original order to understand the current state
    const orderQuery = `
      query getOrder($id: ID!) {
        order(id: $id) {
          id
          name
          email
          phone
          createdAt
          updatedAt
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          customer {
            firstName
            lastName
            email
            phone
          }
          shippingAddress {
            firstName
            lastName
            address1
            address2
            city
            province
            country
            zip
          }
          billingAddress {
            firstName
            lastName
            address1
            address2
            city
            province
            country
            zip
          }
          metafields(first: 10, namespace: "sku_tracking") {
            edges {
              node {
                key
                value
              }
            }
          }
          lineItems(first: 50) {
            nodes {
              id
              sku
              quantity
              title
              variantTitle
              variant {
                id
                title
                inventoryItem {
                  id
                  sku
                }
              }
            }
          }
        }
      }
    `;

    const orderData = await makeShopifyGraphQLRequest(
      session,
      orderQuery,
      {
        id: `gid://shopify/Order/${payload.order_edit.order_id}`,
      }
    );

    const order = orderData.data.order;
    if (!order) {
      throw new Error(`Order ${payload.order_edit.order_id} not found`);
    }

    console.log('📥 Order data received:', {
      orderName: order.name,
      customerEmail: order.email,
      lineItemsCount: order.lineItems.nodes.length,
      hasMetafields: order.metafields.edges.length > 0
    });

    // Get the assigned subSKUs from metafields
    const assignedSubSKUsMetafield = order.metafields.edges.find(
      edge => edge.node.key === 'assigned_subskus'
    );

    let assignedSubSKUs = {};
    if (assignedSubSKUsMetafield) {
      assignedSubSKUs = JSON.parse(assignedSubSKUsMetafield.node.value);
    }

    const updatedAssignedSubSKUs = { ...assignedSubSKUs };
    const sheetData = [];
    const results = [];

    // Process additions (new items added to the order)
    for (const addition of payload.order_edit.line_items.additions) {
      const lineItemId = addition.id;
      const delta = addition.delta;

      console.log('➕ Processing addition:', {
        lineItemId,
        delta
      });

      // Find the line item in the order
      const lineItem = order.lineItems.nodes.find(
        node => {
          const nodeId = node.id.includes('gid://') 
            ? node.id.split('/').pop() 
            : node.id;
          return nodeId === lineItemId.toString();
        }
      );

      if (!lineItem) {
        console.log('⚠️ Line item not found for addition:', lineItemId);
        continue;
      }

      const sku = lineItem.sku;
      if (!sku) {
        console.log('⚠️ No SKU found for line item:', lineItemId);
        continue;
      }

      // Check if we have enough available subSKUs
      const [availableData] = await getAvailableSKUs(sku);
      const availableQuantity = availableData?.availableQuantity || 0;

      if (availableQuantity < delta) {
        console.log('❌ Insufficient available subSKUs:', {
          sku,
          required: delta,
          available: availableQuantity
        });
        results.push({
          lineItemId,
          sku,
          success: false,
          error: 'Insufficient available subSKUs',
          type: 'addition'
        });
        continue;
      }

      // Get the next available subSKUs
      const subSKUsToAssign = [];
      for (let i = 0; i < delta; i++) {
        const nextSubSKU = await getNextAvailableSubSKU(sku);
        if (nextSubSKU) {
          subSKUsToAssign.push(nextSubSKU);
        }
      }

      if (subSKUsToAssign.length !== delta) {
        console.log('❌ Could not get enough subSKUs:', {
          sku,
          required: delta,
          got: subSKUsToAssign.length
        });
        results.push({
          lineItemId,
          sku,
          success: false,
          error: 'Could not get enough subSKUs',
          type: 'addition'
        });
        continue;
      }

      // Mark subSKUs as unavailable
      await updateSubSKUStatus(
        sku,
        subSKUsToAssign,
        "unavailable"
      );

      // Update assigned subSKUs
      const existingAssigned = assignedSubSKUs[lineItemId] || [];
      updatedAssignedSubSKUs[lineItemId] = [...existingAssigned, ...subSKUsToAssign];

      // Get variant weight
      let weightInGrams = null;
      try {
        const variantResponse = await fetch(
          `https://${session.shop}/admin/api/2025-01/variants/${lineItem.variant.id.split('/').pop()}.json?fields=weight_unit,weight`,
          {
            headers: {
              'X-Shopify-Access-Token': session.accessToken,
            },
          }
        );

        const variantData = await variantResponse.json();
        const variant = variantData.variant;

        if (variant?.weight && variant?.weight_unit) {
          switch (variant.weight_unit.toLowerCase()) {
            case 'kg':
              weightInGrams = variant.weight * 1000;
              break;
            case 'g':
              weightInGrams = variant.weight;
              break;
            case 'lb':
              weightInGrams = variant.weight * 453.592;
              break;
            case 'oz':
              weightInGrams = variant.weight * 28.3495;
              break;
          }
        }
      } catch (error) {
        console.error(`Error fetching variant weight for ${sku}:`, error);
      }

      // Add to sheet data for each subSKU
      const currentDate = order.updatedAt ? new Date(order.updatedAt) : order.createdAt ? new Date(order.createdAt) : new Date();
      const timeParisZone = currentDate.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris' });

      subSKUsToAssign.forEach((subSkuName) => {
        sheetData.push([
          "", // Date
          timeParisZone, // Time (Paris Time Zone)
          order.name, // Invoice Number
          lineItem.title, // Item Title
          sku, // SKU
          subSkuName, // Sub-SKU
          lineItem.variantTitle || "", // Variant
          "", // Selected Size
          weightInGrams || "", // Output Weight
          "Order Edit - Addition", // Output Reason
          "", // Free Handwritten Note
          `${order.customer?.firstName || ""} ${order.customer?.lastName || ""}`.trim(), // Customer Name
          order.customer?.email || "", // Email
          order.customer?.phone || "", // Telephone
          "", // Attachment pdf - jpg
          "", // Supplier Name
          "", // Supplier Address
          "", // ID session staff
          `Order Edit ID: ${payload.order_edit.id}`, // Note
        ]);
      });

      results.push({
        lineItemId,
        sku,
        success: true,
        type: 'addition',
        quantity: delta,
        assignedSubSKUs: subSKUsToAssign
      });
    }

    // Process removals (items removed from the order)
    for (const removal of payload.order_edit.line_items.removals) {
      const lineItemId = removal.id;
      const delta = removal.delta;

      console.log('➖ Processing removal:', {
        lineItemId,
        delta
      });

      // Find the line item in the order
      const lineItem = order.lineItems.nodes.find(
        node => {
          const nodeId = node.id.includes('gid://') 
            ? node.id.split('/').pop() 
            : node.id;
          return nodeId === lineItemId.toString();
        }
      );

      if (!lineItem) {
        console.log('⚠️ Line item not found for removal:', lineItemId);
        continue;
      }

      const sku = lineItem.sku;
      if (!sku) {
        console.log('⚠️ No SKU found for line item:', lineItemId);
        continue;
      }

      // Get the assigned subSKUs for this line item
      const lineItemSubSKUs = assignedSubSKUs[lineItemId] || [];
      
      if (lineItemSubSKUs.length < delta) {
        console.log('⚠️ Not enough assigned subSKUs for removal:', {
          lineItemId,
          required: delta,
          assigned: lineItemSubSKUs.length
        });
        results.push({
          lineItemId,
          sku,
          success: false,
          error: 'Not enough assigned subSKUs',
          type: 'removal'
        });
        continue;
      }

      // Get the subSKUs to mark as available (last N subSKUs)
      const subSKUsToMarkAvailable = lineItemSubSKUs.slice(-delta);
      
      console.log('🔄 Preparing to mark subSKUs as available:', {
        inventoryItemId: lineItem.variant.inventoryItem.id,
        delta,
        subSKUsToMarkAvailable,
        remainingSubSKUs: lineItemSubSKUs.slice(0, -delta)
      });

      // Update the assigned subSKUs in our local copy
      updatedAssignedSubSKUs[lineItemId] = lineItemSubSKUs.slice(0, -delta);

      console.log('🔄 Marking subSKUs as available:', {
        sku,
        delta,
        subSKUs: subSKUsToMarkAvailable
      });

      // Update the subSKUs status
      await updateSubSKUStatus(
        sku,
        subSKUsToMarkAvailable,
        "available"
      );

      // Get updated quantities
      const [updatedSkuData] = await getAvailableSKUs(sku);
      const ourNewQuantity = updatedSkuData.availableQuantity;

      console.log('📊 Updated SKU data:', {
        sku,
        ourNewQuantity,
        totalQuantity: updatedSkuData.totalQuantity,
        availableSubSKUs: updatedSkuData.availableSubSkus
      });

      // Get Shopify quantity
      const shopifyData = await makeShopifyGraphQLRequest(
        session,
        `
        query getInventoryItemBySku($sku: String!) {
          inventoryItems(first: 1, query: $sku) {
            edges {
              node {
                id
                sku
                variant {
                  sku
                  inventoryQuantity
                }
              }
            }
          }
        }
      `,
        { sku: `sku:${sku}` }
      );

      const shopifyQuantity = shopifyData.data.inventoryItems.edges
        .filter(edge => edge.node.sku === sku)
        .reduce((total, edge) => total + (edge.node.variant?.inventoryQuantity || 0), 0);

      console.log('📊 Quantity comparison after marking available:', {
        sku,
        ourNewQuantity,
        shopifyQuantity,
        difference: ourNewQuantity - shopifyQuantity
      });

      // If our quantity is now greater than Shopify's, remove excess subSKUs
      if (ourNewQuantity > shopifyQuantity) {
        const toRemove = ourNewQuantity - shopifyQuantity;
        console.log('➖ Removing excess subSKUs:', {
          sku,
          toRemove,
          ourQuantity: ourNewQuantity,
          shopifyQuantity
        });
        await removeSubSKUsByQuantity(sku, toRemove);
      }

      // Add to sheet data for each subSKU being returned
      const currentDate = order.updatedAt ? new Date(order.updatedAt) : order.createdAt ? new Date(order.createdAt) : new Date();
      const timeParisZone = currentDate.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris' });

      subSKUsToMarkAvailable.forEach((subSkuName) => {
        sheetData.push([
          "", // Date
          timeParisZone, // Time (Paris Time Zone)
          order.name, // Invoice Number
          lineItem.title, // Item Title
          sku, // SKU
          subSkuName, // Sub-SKU
          lineItem.variantTitle || "", // Variant
          "", // Selected Size
          "", // Output Weight
          "Order Edit - Removal", // Output Reason
          "", // Free Handwritten Note
          `${order.customer?.firstName || ""} ${order.customer?.lastName || ""}`.trim(), // Customer Name
          order.customer?.email || "", // Email
          order.customer?.phone || "", // Telephone
          "", // Attachment pdf - jpg
          "", // Supplier Name
          "", // Supplier Address
          "", // ID session staff
          `Order Edit ID: ${payload.order_edit.id}`, // Note
        ]);
      });

      results.push({
        sku,
        lineItemId,
        inventoryItemId: lineItem.variant.inventoryItem.id,
        success: true,
        type: 'removal',
        quantity: delta,
        markedAvailable: subSKUsToMarkAvailable,
        removedExcess: ourNewQuantity > shopifyQuantity ? ourNewQuantity - shopifyQuantity : 0
      });
    }

    // Update the metafields with the updated assigned subSKUs
    if (Object.keys(updatedAssignedSubSKUs).length > 0) {
      const mutation = `
        mutation createOrderMetafields($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields {
              id
              key
              value
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      const metafieldInput = {
        metafields: [
          {
            ownerId: `gid://shopify/Order/${payload.order_edit.order_id}`,
            namespace: "sku_tracking",
            key: "assigned_subskus",
            type: "json",
            value: JSON.stringify(updatedAssignedSubSKUs)
          }
        ]
      };

      await makeShopifyGraphQLRequest(session, mutation, metafieldInput);
    }

    // Append data to Google Sheet
    if (sheetData.length > 0) {
      console.log(`📊 Appending ${sheetData.length} rows to Orders sheet for order edit ${payload.order_edit.id}`);
      
      const authClient = await auth.getClient();
      const sheets = google.sheets({ version: "v4", auth: authClient });

      // Get the last row index
      const existingData = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: "Orders!A:Z",
      });
      const existingRows = existingData.data.values || [];
      const lastRowIndex = existingRows.length;

      // Append the new data
      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: `Orders!A${lastRowIndex + 1}`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: sheetData,
        },
      });

      // Apply background colors based on operation type
      const formatRequests = [];
      let currentRow = lastRowIndex + 1;

      for (const row of sheetData) {
        const reason = row[9]; // Output Reason column
        let backgroundColor = null;

        if (reason === "Order Edit - Addition") {
          backgroundColor = { red: 0.8, green: 1.0, blue: 0.8 }; // Light green
        } else if (reason === "Order Edit - Removal") {
          backgroundColor = { red: 1.0, green: 0.8, blue: 0.8 }; // Light red
        }

        if (backgroundColor) {
          formatRequests.push({
            repeatCell: {
              range: {
                sheetId: await getSheetId(sheets, "Orders"),
                startRowIndex: currentRow - 1,
                endRowIndex: currentRow,
                startColumnIndex: 0,
                endColumnIndex: 19, // All columns
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: backgroundColor,
                  textFormat: { 
                    foregroundColor: { red: 0, green: 0, blue: 0 } // Black text for light backgrounds
                  }
                },
              },
              fields: "userEnteredFormat(backgroundColor,textFormat)",
            },
          });
        }
        currentRow++;
      }

      // Apply formatting if there are any format requests
      if (formatRequests.length > 0) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: process.env.GOOGLE_SHEET_ID,
          requestBody: { requests: formatRequests },
        });
        console.log(`✅ Applied background colors to ${formatRequests.length} rows`);
      }

      console.log(`✅ Successfully appended ${sheetData.length} rows to Orders sheet`);
    }

    // Prepend data to Google Sheet
    if (sheetData.length > 0) {
      console.log(`📊 Prepending ${sheetData.length} rows to Orders sheet for order edit ${payload.order_edit.id}`);
      
      const authClient = await auth.getClient();
      const sheets = google.sheets({ version: "v4", auth: authClient });

      // Use the new prepend function
      await prependDataToSheet("Orders", sheetData, 3);

      // Apply background colors based on operation type
      const formatRequests = [];
      let currentRow = 3; // Start from row 3 (after header and date row)

      for (const row of sheetData) {
        const reason = row[9]; // Output Reason column
        let backgroundColor = null;

        if (reason === "Order Edit - Addition") {
          backgroundColor = { red: 0.8, green: 1.0, blue: 0.8 }; // Light green
        } else if (reason === "Order Edit - Removal") {
          backgroundColor = { red: 1.0, green: 0.8, blue: 0.8 }; // Light red
        }

        if (backgroundColor) {
          formatRequests.push({
            repeatCell: {
              range: {
                sheetId: await getSheetId(sheets, "Orders"),
                startRowIndex: currentRow - 1,
                endRowIndex: currentRow,
                startColumnIndex: 0,
                endColumnIndex: 19, // All columns
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: backgroundColor,
                  textFormat: { 
                    foregroundColor: { red: 0, green: 0, blue: 0 } // Black text for light backgrounds
                  }
                },
              },
              fields: "userEnteredFormat(backgroundColor,textFormat)",
            },
          });
        }
        currentRow++;
      }

      // Apply formatting if there are any format requests
      if (formatRequests.length > 0) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: process.env.GOOGLE_SHEET_ID,
          requestBody: { requests: formatRequests },
        });
        console.log(`✅ Applied background colors to ${formatRequests.length} rows`);
      }

      console.log(`✅ Successfully prepended ${sheetData.length} rows to Orders sheet`);
    }

    console.log('✅ Order edit completed:', {
      orderEditId: payload.order_edit.id,
      orderId: payload.order_edit.order_id,
      processedItems: results.length,
      successfulItems: results.filter(r => r.success).length,
      failedItems: results.filter(r => !r.success).length,
      sheetRowsAdded: sheetData.length
    });

    return {
      success: true,
      data: {
        orderEditId: payload.order_edit.id,
        orderId: payload.order_edit.order_id,
        results,
        sheetRowsAdded: sheetData.length
      }
    };
  } catch (error) {
    console.error('❌ Error processing order edit:', {
      error: error.message,
      stack: error.stack,
      orderEditId: payload.order_edit?.id,
      orderId: payload.order_edit?.order_id
    });
    return {
      success: false,
      error: error.message
    };
  }
}
