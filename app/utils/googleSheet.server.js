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

const auth = new google.auth.GoogleAuth({
  credentials: getServiceAccountCredentials(),
  scopes: SCOPES,
});

export async function upsertRowsToGoogleSheet(productId, newRows) {
  const authClient = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: authClient });

  // Step 1: Fetch all existing rows (excluding header)
  const getRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Sheet1!A2:H",
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
    range: "Sheet1!A2:H",
  });

  // Step 5: Write all data back (clean sheet — no blanks)
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: "Sheet1!A2",
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
    range: "Sheet1!A1:H1", // Adjust based on number of columns
  });

  const headers = res.data.values?.[0] || [];

  if (headers.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: "Sheet1!A1",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [
          [
            "Product ID",
            "Date",
            "TIME",
            "Paris zone",
            "Item Title",
            "SKU",
            "Sub-SKU",
            "Variant"
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
      "Invoice Number",
      "Order ID",
      "Customer Name",
      "Email",
      "Address",
      "Telephone",
      "Total Price",
      "Variant",
      "Item SKU",
      "Item Price",
      "OUTPUT grm",
      "Supplier Name",
      "Assigned SubSKUs",
      "Selected Size"
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
    range: "Sheet1!A2:Z", // extend to Z to include extra columns
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
      const updateRange = `Sheet1!I${index + 2}:M${index + 2}`; // I-M: Order ID to Phone

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

  // Get all existing data
  const existingData = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${sheetTitle}!A:Z`,
  });

  const existingRows = existingData.data.values || [];
  const headerRow = existingRows[0] || [];
  const dataRows = existingRows.slice(1);

  // Get the last row index
  const lastRowIndex = dataRows.length + 1; // +1 for header row
  let currentRowIndex = lastRowIndex;

  // Get existing dates from the sheet
  const existingDates = await getExistingDatesFromSheet(sheets, sheetTitle);

  // Process each date group
  for (const [date, ordersForDate] of Object.entries(grouped)) {
    // If date already exists, add a blank row first
    if (existingDates.has(date)) {
      allRows.push([]);
      currentRowIndex++;
    }

    // Add date header
    allRows.push([date]);
    formatRequests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: currentRowIndex,
          endRowIndex: currentRowIndex + 1,
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
    currentRowIndex++;

    // Add order rows for this date
    for (const order of ordersForDate) {
      for (const lineItem of order.lineItems) {
        if (lineItem.assigned_subskus && lineItem.assigned_subskus.length > 0) {
          for (const subSKU of lineItem.assigned_subskus) {
            allRows.push([
              order.name,
              order.orderId,
              order.customerName,
              order.email,
              order.address,
              order.phone,
              order.totalPrice,
              lineItem.variant,
              lineItem.sku,
              lineItem.price,
              lineItem.weight,
              lineItem.vendor,
              subSKU,
              getPropertyValue(lineItem.properties, "__selected_size")
            ]);
            currentRowIndex++;
          }
        }
      }
    }

    // Add empty row after each date group
    allRows.push([]);
    currentRowIndex++;
  }

  // Append new data if there are rows to add
  if (allRows.length > 0) {
    // Write all data starting from the last row
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${sheetTitle}!A${lastRowIndex + 1}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: allRows,
      },
    });

    // Apply formatting
    if (formatRequests.length > 0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { requests: formatRequests },
      });
    }
  }

  console.log(`✅ Orders appended to "${sheetTitle}" with proper date-based sorting`);
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
      customerName: payload.customer ? payload.customer.first_name : "N/A",
      email: payload.contact_email,
      address: payload.shipping_address
        ? payload.shipping_address.address1
        : "N/A",
      phone: payload.phone,
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
