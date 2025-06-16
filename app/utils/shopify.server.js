import { ApiVersion } from "@shopify/shopify-api";

/**
 * Make a GraphQL request to Shopify using session credentials
 * @param {object} session - Shopify session object containing shop and accessToken
 * @param {string} query - GraphQL query string
 * @param {object} variables - Variables for the GraphQL query
 * @returns {Promise<object>} - GraphQL response
 */
export async function makeShopifyGraphQLRequest(session, query, variables = {}) {
  const { shop, accessToken } = session;
  const apiUrl = `https://${shop}/admin/api/${ApiVersion.January25}/graphql.json`;

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      throw new Error(`GraphQL request failed: ${response.statusText}`);
    }

    const data = await response.json();
    
    if (data.errors) {
      throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
    }

    return data;
  } catch (error) {
    console.error("GraphQL request error:", error);
    throw error;
  }
} 