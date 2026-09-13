import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { createRoot } from "react-dom/client";
import { IntegrationSetup } from "../../src/components/integrations/IntegrationSetup";
import { PluginsOverlay } from "../../src/pages/PluginsOverlay";
import "../../src/styles.css";

const i18n = setupI18n({ locale: "en", messages: { en: {} } });
createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    {new URLSearchParams(location.search).has("setup") ? (
      <main className="mx-auto max-w-xl p-6">
        <IntegrationSetup serverSetup />
      </main>
    ) : (
      <PluginsOverlay onClose={() => undefined} />
    )}
  </I18nProvider>,
);
