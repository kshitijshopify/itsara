import {
  Page,
  Layout,
  Text,
  Card,
  BlockStack,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export default function Index() {
  return (
    <Page>
      <TitleBar title="Product & Order Analytics" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="500">
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">Product Analytics</Text>
                <Text as="p" variant="bodyMd">
                  Comprehensive tracking of product creation metrics including sub-SKU details, weight specifications, and creation timestamps. Monitor your product catalog's growth and organization.
                </Text>
                <Text as="p" variant="bodyMd">
                  • Track individual sub-SKU performance metrics
                  • Monitor weight variations and specifications
                  • View creation and modification history
                  • Analyze product catalog organization
                  • Track inventory levels and stock status
                </Text>
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="500">
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">Order Analytics</Text>
                <Text as="p" variant="bodyMd">
                  Detailed analysis of sub-SKU performance, including weight-based sales metrics, quantity tracking, and chronological order data. Gain insights into your product's market performance and customer purchasing patterns.
                </Text>
                <Text as="p" variant="bodyMd">
                  • Real-time sales performance tracking
                  • Weight-based order analysis
                  • Customer purchase patterns
                  • Seasonal trend identification
                  • Revenue and profit metrics
                  • Order fulfillment status
                </Text>
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
