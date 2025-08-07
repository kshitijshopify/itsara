import { google } from "googleapis";
import { auth, ensureSheetTabExists, getSheetId } from "./googleSheet.server";

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

export async function ensureInventoryReduceSheet() {
  // Use existing function to create sheet if it doesn't exist
  await ensureSheetTabExists("Inventory Reduce");
  
  const authClient = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: authClient });

  // Check if headers exist
  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Inventory Reduce!A1:E1",
  });

  const headers = headerRes.data.values?.[0] || [];

  if (headers.length === 0) {
    // Add headers
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: "Inventory Reduce!A1",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [["Date", "Timing", "SKU", "Reduced by", "Value"]],
      },
    });
    console.log("✅ Added headers to 'Inventory Reduce' sheet");
  } else {
    console.log("ℹ️ Headers already exist in 'Inventory Reduce' sheet");
  }
}

export async function logInventoryReductionWithReason(sku, quantity, reason) {
  try {
    await ensureInventoryReduceSheet();
    console.log("🔍 Logging inventory reduction with reason:", { sku, quantity, reason });
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: "v4", auth: authClient });

    const currentDate = new Date();
    const dateString = currentDate.toISOString().split("T")[0];
    const timeString = currentDate.toLocaleTimeString('en-US', { 
      timeZone: 'Europe/Paris',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    const newRow = [
      dateString,           // Date
      timeString,           // Timing
      sku,                  // SKU
      reason,               // Reduced by (reason)
      quantity.toString()   // Value (quantity removed)
    ];

    // Use the same approach as prependDataToSheet
    // Step 1: Insert a new row at the top (after header)
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{
          insertDimension: {
            range: {
              sheetId: await getSheetId(sheets, "Inventory Reduce"),
              dimension: "ROWS",
              startIndex: 1, // After header row
              endIndex: 2
            },
            inheritFromBefore: false
          }
        }]
      }
    });

    // Step 2: Clear formatting from the inserted row
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{
          repeatCell: {
            range: {
              sheetId: await getSheetId(sheets, "Inventory Reduce"),
              startRowIndex: 1,
              endRowIndex: 2,
              startColumnIndex: 0,
              endColumnIndex: 5
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 1, green: 1, blue: 1 }, // White background
                textFormat: {
                  foregroundColor: { red: 0, green: 0, blue: 0 }, // Black text
                  bold: false,
                  italic: false
                }
              }
            },
            fields: "userEnteredFormat(backgroundColor,textFormat)"
          }
        }]
      }
    });

    // Step 3: Write data to the new row (row 2)
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: "Inventory Reduce!A2",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [newRow],
      },
    });

    console.log(`✅ Logged inventory reduction: SKU ${sku}, Quantity: ${quantity}, Reason: ${reason}`);
    
    return {
      success: true,
      message: "Inventory reduction logged successfully"
    };
  } catch (error) {
    console.error("❌ Error logging inventory reduction:", error);
    return {
      success: false,
      error: error.message
    };
  }
}

 