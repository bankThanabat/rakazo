import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { GatewayRuntimes } from "../../src/components/integrations/GatewaySettings";
import { IntegrationSetup } from "../../src/components/integrations/IntegrationSetup";
import { PluginsOverlay } from "../../src/pages/PluginsOverlay";
import "../../src/styles.css";

const i18n = setupI18n({ locale: "en", messages: { en: {} } });
function ConnectionFixture() {
  const [assistant, setAssistant] = useState<{ botId: string; name: string } | null>(null);
  return assistant ? (
    <main>
      <h1>{assistant.name}</h1>
      <button type="button" onClick={() => setAssistant(null)}>
        Back to integrations
      </button>
    </main>
  ) : (
    <PluginsOverlay
      activeBotId="setup-assistant"
      onClose={() => undefined}
      onOpenAssistant={setAssistant}
    />
  );
}
createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    {new URLSearchParams(location.search).has("runtime") ? (
      <GatewayRuntimes />
    ) : new URLSearchParams(location.search).has("setup") ? (
      <main className="mx-auto max-w-xl p-6">
        <IntegrationSetup serverSetup />
      </main>
    ) : (
      <ConnectionFixture />
    )}
  </I18nProvider>,
);
