import { Trans } from "@lingui/react/macro";
import { useNavigate } from "react-router-dom";
import { WindowChrome } from "./WindowChrome";

export function WelcomePage() {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-full flex-col bg-background" data-rakazo-surface="welcome">
      <div className="app-drag flex gap-2 px-5 py-[18px]">
        <WindowChrome />
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-11 px-6 pb-[90px]">
        <div className="flex items-center gap-4 sm:gap-[26px]">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center gap-[13px] rounded-full bg-accent sm:h-[88px] sm:w-[88px]">
            <span className="h-6 w-[11px] rounded-full bg-card" />
            <span className="h-6 w-[11px] rounded-full bg-card" />
          </div>
          <h1 className="text-[44px] leading-none tracking-[-0.03em] text-foreground sm:text-[76px]">
            Deskazo
          </h1>
        </div>
        <p className="max-w-[600px] text-center text-xl leading-[1.4] text-foreground/75 sm:text-[27px]">
          <Trans>
            Your team of always-on agents
            <br />
            that you can give real work to.
          </Trans>
        </p>
        <button
          type="button"
          onClick={() => navigate("/sign-up")}
          className="app-no-drag rounded-full bg-accent px-[34px] py-[15px] text-[19px] text-foreground transition hover:scale-[1.04] hover:bg-accent"
        >
          <Trans>Sign up</Trans>&nbsp;&nbsp;→
        </button>
      </div>
    </div>
  );
}
