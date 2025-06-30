import prisma from "../db.server";

export async function loader({ request }) {
  try {
    const url = new URL(request.url);
    const productId = url.searchParams.get("productId");
    const shopUrl = url.searchParams.get("shopUrl");

    // Validate required parameters
    if (!productId || !shopUrl) {
      return new Response(
        JSON.stringify({ 
          error: "Missing required parameters: productId and shopUrl" 
        }), 
        { 
          status: 400, 
          headers: { "Content-Type": "application/json" } 
        }
      );
    }

    // Get access token from Session model based on shop URL
    const session = await prisma.session.findFirst({
      where: { shop: shopUrl },
      select: { accessToken: true }
    });

    if (!session) {
      return new Response(
        JSON.stringify({ 
          error: "No session found for this shop" 
        }), 
        { 
          status: 404, 
          headers: { "Content-Type": "application/json" } 
        }
      );
    }

    // Hit Shopify Admin API to get product variants
    const response = await fetch(
      `https://${shopUrl}/admin/api/2024-01/products/${productId}.json`,
      {
        headers: {
          "X-Shopify-Access-Token": session.accessToken,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      return new Response(
        JSON.stringify({ 
          error: `Shopify API error: ${response.status} ${response.statusText}` 
        }), 
        { 
          status: response.status, 
          headers: { "Content-Type": "application/json" } 
        }
      );
    }

    const productData = await response.json();
    
    // Return only the variants
    return new Response(
      JSON.stringify({ 
        variants: productData.product?.variants || [] 
      }), 
      { 
        status: 200, 
        headers: { 
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=300" // Cache for 5 minutes
        } 
      }
    );

  } catch (error) {
    console.error("Error fetching product variants:", error);
    return new Response(
      JSON.stringify({ 
        error: "Internal server error" 
      }), 
      { 
        status: 500, 
        headers: { "Content-Type": "application/json" } 
      }
    );
  }
} 