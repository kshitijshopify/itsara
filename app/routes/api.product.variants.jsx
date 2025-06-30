import prisma from "../db.server";

export async function loader({ request }) {
  const url = new URL(request.url);

  // CORS: Handle preflight OPTIONS request
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  // Allow only GET method
  if (request.method !== "GET") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      {
        status: 405,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  try {
    const productId = url.searchParams.get("productId");
    const shopUrl = url.searchParams.get("shopUrl");

    // Validate required parameters
    if (!productId || !shopUrl) {
      return new Response(
        JSON.stringify({
          error: "Missing required parameters: productId and shopUrl",
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    // Validate shop URL format
    const shopUrlRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;
    if (!shopUrlRegex.test(shopUrl)) {
      return new Response(
        JSON.stringify({
          error:
            "Invalid shop URL format. Must be a valid Shopify domain (e.g., your-shop.myshopify.com)",
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    // Get access token from session
    const session = await prisma.session.findFirst({
      where: { shop: shopUrl },
      select: { accessToken: true },
    });

    if (!session) {
      return new Response(
        JSON.stringify({ error: "No session found for this shop" }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    // Fetch product data from Shopify Admin API
    const shopifyResponse = await fetch(
      `https://${shopUrl}/admin/api/2024-01/products/${productId}.json`,
      {
        headers: {
          "X-Shopify-Access-Token": session.accessToken,
          "Content-Type": "application/json",
        },
      }
    );

    if (!shopifyResponse.ok) {
      return new Response(
        JSON.stringify({
          error: `Shopify API error: ${shopifyResponse.status} ${shopifyResponse.statusText}`,
        }),
        {
          status: shopifyResponse.status,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    const data = await shopifyResponse.json();

    return new Response(
      JSON.stringify({ variants: data.product?.variants || [] }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=300",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  } catch (error) {
    console.error("Error fetching product variants:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
}
