import type { IntegrationProviderConfig, IntegrationProviderId } from "@rakazo/contracts";
import { gatewayAuthorizationUrl } from "./connection-authorization.js";

export type IntegrationChoice =
  | "direct"
  | "composio"
  | "pipedream"
  | "open-connector"
  | "gateway"
  | "executor";

/** The server-side provider a setup choice configures; unmanaged choices have none. */
export function integrationChoiceProvider(choice: string): IntegrationProviderId | null {
  switch (choice) {
    case "composio":
    case "pipedream":
    case "open-connector":
      return choice;
    case "gateway":
      return "open-connector";
    default:
      return null;
  }
}

export function integrationCredentialsUrl(choice: string, endpoint: string): string | null {
  switch (choice) {
    case "gateway":
      return gatewayAuthorizationUrl(endpoint);
    case "composio":
      return "https://dashboard.composio.dev";
    case "open-connector":
      return "https://github.com/oomol-lab/open-connector/blob/main/docs/programmatic-connections.md";
    default:
      return "https://pipedream.com/docs/connect/mcp/developers";
  }
}

/** Shapes the credentials form into the provider configuration the API saves. */
export function integrationProviderInput(
  choice: string,
  values: { apiKey: string; endpoint: string; clientId: string; projectId: string },
): IntegrationProviderConfig {
  switch (choice) {
    case "composio":
      return { provider: "composio", apiKey: values.apiKey };
    case "open-connector":
    case "gateway":
      return {
        provider: "open-connector",
        endpoint: values.endpoint,
        apiKey: values.apiKey,
        mode: choice === "gateway" ? "gateway" : "direct",
      };
    default:
      return {
        provider: "pipedream",
        clientId: values.clientId,
        clientSecret: values.apiKey,
        projectId: values.projectId,
        environment: "production",
      };
  }
}
