import { google } from "googleapis";
// import { resolve } from "path";
// import fs from "fs";

// const KEY_FILE_PATH = resolve(
//   process.cwd(),
//   process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH,
// );
const SHEET_ID = process.env.GOOGLE_SHEET_ID;

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

// Load and process the service account credentials
function getServiceAccountCredentials() {
  // const keyFile = JSON.parse(fs.readFileSync(KEY_FILE_PATH, 'utf8'));
  return {
    type: process.env.GOOGLE_TYPE,
    private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    client_id: process.env.GOOGLE_CLIENT_ID,
    project_id: process.env.GOOGLE_PROJECT_ID,
    auth_uri: process.env.GOOGLE_AUTH_URI,
    token_uri: process.env.GOOGLE_TOKEN_URI,
    auth_provider_x509_cert_url: process.env.GOOGLE_AUTH_PROVIDER_X509_CERT_URL,
    client_x509_cert_url: process.env.GOOGLE_CLIENT_X509_CERT_URL,
    universe_domain: process.env.GOOGLE_UNIVERSE_DOMAIN,
  };
}

export const auth = new google.auth.GoogleAuth({
  credentials: getServiceAccountCredentials(),
  scopes: SCOPES,
});

export async function upsertRowsToGoogleSheet(productId, newRows) {
  const authClient = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: authClient });

  // Step 1: Fetch all existing rows (excluding header)
  const getRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Inventory Updates!A2:H",
  });

  const existingRows = getRes.data.values || [];

  // Step 2: Filter out old rows for the same product
  const filteredRows = existingRows.filter(
    (row) => row[0] !== String(productId),
  );

  // Step 3: Combine old + new rows
  const updatedRows = [...filteredRows, ...newRows];

  // Step 4: Clear the entire data range (below header)
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: "Inventory Updates!A2:H",
  });

  // Step 5: Write all data back (clean sheet — no blanks)
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: "Inventory Updates!A2",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: updatedRows,
    },
  });

  console.log(
    `✅ Product ${productId} synced with ${newRows.length} row(s). All rows compacted.`,
  );
}

export async function ensureSheetHasHeader() {
  const authClient = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: authClient });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Inventory Updates!A1:H1", // Adjust based on number of columns
  });

  const headers = res.data.values?.[0] || [];

  if (headers.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: "Inventory Updates!A1",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [
          [
            "Date",
            "Time (Paris Time Zone)",
            "Item Title",
            "SKU",
            "Sub SKU",
            "Variant",
            "Input Weight",
            "Input Reason",
            "Free Handwritten Note",
            "Supplier Name",
            "Supplier Address"
          ],
        ],
      },
    });

    console.log("✅ Header row added to sheet");
  } else {
    console.log("ℹ️ Header already exists");
  }
}

export async function addSheetOrderHeader(sheets, sheetTitle) {
  const header = [
    [
      "Date",
      "Time(Paris Time Zone)",
      "Invoice Number",
      "Item Title",
      "SKU",
      "Sub-SKU",
      "Variant",
      "Selected Size",
      "Output Weight",
      "Output Reason",
      "Free Handwritten Note",
      "Customer Name",
      "Email",
      "Telephone",
      "Attachment pdf - jpg",
      "Supplier Name",
      "Supplier Address",
      "ID session staff",
      "Note",
    ],
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${sheetTitle}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: header },
  });
}

export async function updateSubSkuWithOrderInfo(sku, orderData) {
  const authClient = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: authClient });

  // 1. Read the full data from sheet
  const getRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Inventory Updates!A2:Z", // extend to Z to include extra columns
  });

  const rows = getRes.data.values || [];

  // 2. Find matching SKU rows
  const skuMatches = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row[6] === sku); // SKU is in column C (index 2)

  console.log("rowwwssss>>>", JSON.stringify(rows), skuMatches, "<<<<rows");

  for (const { row, index } of skuMatches) {
    const orderIdCell = row[8]; // Order ID is assumed to be column I (index 8)

    if (!orderIdCell) {
      // 3. First empty slot → update it
      const updateRange = `Inventory Updates!I${index + 2}:M${index + 2}`; // I-M: Order ID to Phone

      const values = [
        [
          orderData.orderId,
          orderData.customerName,
          orderData.email,
          orderData.address,
          orderData.phone,
        ],
      ];

      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: updateRange,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values,
        },
      });

      console.log(`✅ Order info added to SKU ${sku} at row ${index + 2}`);
      return;
    }
  }

  console.warn(`⚠️ No available SUBSKU row found for SKU ${sku}`);
}

export async function ensureSheetTabExists(sheetTitle) {
  const authClient = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: authClient });

  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
  });
  const sheetExists = spreadsheet.data.sheets?.some(
    (s) => s.properties?.title === sheetTitle,
  );

  if (!sheetExists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: sheetTitle,
              },
            },
          },
        ],
      },
    });
    console.log(`✅ Created sheet tab "${sheetTitle}"`);
  } else {
    console.log(`ℹ️ Sheet tab "${sheetTitle}" already exists`);
  }
}

export async function getExistingDatesFromSheet(sheets, sheetTitle) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${sheetTitle}!A:A`,
  });

  const values = response.data.values || [];
  const existingDates = new Set();

  for (const row of values) {
    const cellValue = row[0];
    if (/^\d{4}-\d{2}-\d{2}$/.test(cellValue)) {
      existingDates.add(cellValue);
    }
  }

  return existingDates;
}

export async function insertOrdersGroupedByDate(sheetTitle, orders) {
  const authClient = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: authClient });
  
  // Sort orders by date first
  const sortedOrders = [...orders].sort((a, b) => 
    new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
  
  const grouped = groupByDate(sortedOrders);

  await ensureSheetTabExists(sheetTitle);
  await addSheetOrderHeader(sheets, sheetTitle);

  const allRows = [];
  const formatRequests = [];
  const sheetId = await getSheetId(sheets, sheetTitle);

  // Get existing dates from the sheet
  const existingDates = await getExistingDatesFromSheet(sheets, sheetTitle);

  // Process each date group
  for (const [date, ordersForDate] of Object.entries(grouped)) {
    // If date already exists, skip adding the date header
    if (!existingDates.has(date)) {
      // Add date header only if date doesn't exist
      allRows.push([date]);
      formatRequests.push({
        repeatCell: {
          range: {
            sheetId,
            startRowIndex: allRows.length - 1, // Will be adjusted after prepending
            endRowIndex: allRows.length,
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.9, green: 0.9, blue: 0.6 },
              textFormat: { bold: true },
            },
          },
          fields: "userEnteredFormat(backgroundColor,textFormat)",
        },
      });
    }

    // Track processed order IDs to avoid duplicates
    const processedOrderIds = new Set();

    // Add order rows for this date
    for (const order of ordersForDate) {
      // Skip if we've already processed this order
      if (processedOrderIds.has(order.orderId)) {
        continue;
      }
      processedOrderIds.add(order.orderId);

      // Track processed line items to avoid duplicates
      const processedLineItems = new Set();

      for (const lineItem of order.lineItems) {
        // Skip if we've already processed this line item
        if (processedLineItems.has(lineItem.sku)) {
          continue;
        }
        processedLineItems.add(lineItem.sku);

        if (lineItem.assigned_subskus && lineItem.assigned_subskus.length > 0) {
          // Track processed subSKUs to avoid duplicates
          const processedSubSKUs = new Set();

          for (const subSKU of lineItem.assigned_subskus) {
            // Skip if we've already processed this subSKU
            if (processedSubSKUs.has(subSKU)) {
              continue;
            }
            processedSubSKUs.add(subSKU);
            const timeParisZone = new Date(order.created_at).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris' });
            
            allRows.push([
              "", // Date
              timeParisZone, // Time(Paris Time Zone)
              order.name, // Invoice Number
              lineItem.title, // Item Title
              lineItem.sku, // SKU
              subSKU, // Sub-SKU
              lineItem.variant, // Variant
              lineItem.selected_size, // Selected Size
              lineItem.weight, // Output Weight
              "", // Output Reason
              "", // Free Handwritten Note
              order.customerName, // Customer Name
              order.email, // Email
              order.phone, // Telephone
              "", // Attachment pdf - jpg
              lineItem.vendor, // Supplier Name (vendor)
              "", // Supplier Address
              "", // ID session staff
              "", // Note
            ]);
          }
        }
      }
    }
  }

  // Prepend new data if there are rows to add
  if (allRows.length > 0) {
    // Use the new prepend function
    await prependDataToSheet(sheetTitle, allRows, 3);

    // Apply formatting after prepending (adjust row indices)
    if (formatRequests.length > 0) {
      // Update format requests to account for prepended rows
      const updatedFormatRequests = formatRequests.map(request => ({
        ...request,
        repeatCell: {
          ...request.repeatCell,
          range: {
            ...request.repeatCell.range,
            startRowIndex: request.repeatCell.range.startRowIndex + 2, // +1 for header row
            endRowIndex: request.repeatCell.range.endRowIndex + 2
          }
        }
      }));

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { requests: updatedFormatRequests },
      });
    }
  }

  console.log(`✅ Orders prepended to "${sheetTitle}" with proper date-based sorting`);
}

export function groupByDate(orders) {
  return orders.reduce((acc, order) => {
    // Ensure we're working with a valid date
    const orderDate = new Date(order.created_at);
    if (isNaN(orderDate.getTime())) {
      console.warn(`⚠️ Invalid date for order ${order.orderId}: ${order.created_at}`);
      return acc;
    }
    
    const date = orderDate.toISOString().split("T")[0];
    if (!acc[date]) acc[date] = [];
    acc[date].push(order);
    return acc;
  }, {});
}

export async function getSheetId(sheets, sheetTitle) {
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
  });

  const sheet = spreadsheet.data.sheets?.find(
    (s) => s.properties?.title === sheetTitle,
  );

  return sheet?.properties?.sheetId;
}

export const getSheet = async (sheetName) => {
  try {
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: authClient });
    const response = await sheets.spreadsheets.values.get({
      auth,
      spreadsheetId: SHEET_ID, // Replace with your spreadsheet ID
      range: `${sheetName}!A:Z`, // Adjust the range according to your sheet
    });
    return response.data;
  } catch (error) {
    console.error("Error fetching sheet data:", error);
    throw new Error("Failed to fetch sheet data");
  }
};

export function processWebhookPayload(payload, subSKUAssignments = []) {
  return [
    {
      name: payload.name,
      orderId: payload.id,
      customerName: payload.customer ? `${payload.customer.first_name} ${payload.customer.last_name}` : "N/A",
      email: payload.contact_email,
      address: payload.shipping_address
        ? payload.shipping_address.address1
        : "N/A",
      phone: payload.shipping_address ? payload.shipping_address?.phone : payload.phone ? payload.phone : "N/A",
      totalPrice: payload.total_price,
      created_at: payload.created_at,
      lineItems: payload.line_items.map((lineItem) => {
        const assignment = subSKUAssignments.find(a => a.lineItemId === lineItem.id);
        // Split the subSKUs string into an array if it's a comma-separated string
        let subSKUs = [];
        if (assignment) {
          subSKUs = Array.isArray(assignment.subSKUs) 
            ? assignment.subSKUs 
            : assignment.subSKUs.split(',').map(sku => sku.trim());
        }
        return {
          sku: lineItem.sku,
          price: lineItem.price,
          weight: lineItem.weight_in_gram || lineItem.grams,
          assigned_subskus: subSKUs,
          vendor: lineItem.vendor,
          variant: lineItem.variant_title,
          title: lineItem.title,
          selected_size: getPropertyValue(lineItem.properties, "__selected_size")
        };
      }),
    },
  ];
}

export function getPropertyValue(properties, key) {
  if (!Array.isArray(properties)) return null;

  const prop = properties.find(p => p.name === key);
  return prop ? prop.value : null;
}

export async function prependDataToSheet(sheetTitle, newData, startRowIndex = 3) {
  const authClient = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: authClient });

  if (newData.length === 0) {
    console.log(`ℹ️ No data to prepend to "${sheetTitle}"`);
    return;
  }

  console.log(`📝 Prepending ${newData.length} rows to "${sheetTitle}" starting at row ${startRowIndex}`);

  // Step 1: Insert the required number of rows at the top (after header)
  const insertRequests = [{
    insertDimension: {
      range: {
        sheetId: await getSheetId(sheets, sheetTitle),
        dimension: "ROWS",
        startIndex: startRowIndex - 1, // 0-based index, so subtract 1
        endIndex: startRowIndex - 1 + newData.length
      },
      inheritFromBefore: false
    }
  }];

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests: insertRequests }
  });

  // Step 2: Write the new data into the inserted rows
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${sheetTitle}!A${startRowIndex}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: newData,
    },
  });

  console.log(`✅ Successfully prepended ${newData.length} rows to "${sheetTitle}"`);
}
