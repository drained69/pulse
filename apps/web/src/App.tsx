import { createContext, useContext, useEffect, useState } from "react";
import { api, ApiError, type AppConfig, type Me } from "./api.ts";
import { Billing } from "./pages/Billing.tsx";
import { Docs } from "./pages/Docs.tsx";
import { HookDetail } from "./pages/HookDetail.tsx";
import { HookForm } from "./pages/HookForm.tsx";
import { Hooks } from "./pages/Hooks.tsx";
import { Keys } from "./pages/Keys.tsx";
import { Landing } from "./pages/Landing.tsx";
import { Checkout, PaymentLinks } from "./pages/Pay.tsx";
import { Leaderboard, MyProjects, ProjectForm, ProjectPage } from "./pages/Traction.tsx";
import { StatusPage } from "./pages/Status.tsx";
import { TelegramPage } from "./pages/Telegram.tsx";
import { shortAddr, Spinner } from "./ui.tsx";

type Ctx = { config: AppConfig; me: Me | null; reloadMe: () => Promise<void>; setMe: (m: Me | null) => void };
const AppCtx = createContext<Ctx | null>(null);
export const useApp = (): Ctx => {
  const c = useContext(AppCtx);
  if (!c) throw new Error("no app context");
  return c;
};

export function useRoute(): string[] {
  const read = () => (window.location.hash.replace(/^#\/?/, "") || "").split("/").filter(Boolean);
  const [r, setR] = useState(read);
  useEffect(() => {
    const on = () => {
      setR(read());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return r;
}

export const go = (path: string) => {
  window.location.hash = path.startsWith("#") ? path : `#/${path.replace(/^\//, "")}`;
};

const NAV = [
  { path: "hooks", label: "Hooks", icon: "🪝" },
  { path: "payments", label: "Payment links", icon: "🧾" },
  { path: "projects", label: "Traction pages", icon: "📈" },
  { path: "explore", label: "Leaderboard", icon: "🏆" },
  { path: "telegram", label: "Telegram", icon: "✈️" },
  { path: "keys", label: "API keys", icon: "🔑" },
  { path: "billing", label: "Plan", icon: "💳" },
  { path: "status", label: "Network status", icon: "📡" },
  { path: "docs", label: "Docs", icon: "📘" },
];

function Shell({ route }: { route: string[] }) {
  const { me, setMe } = useApp();
  const section = route[0] ?? "hooks";
  let page;
  if (section === "hooks" && route[1] === "new") page = <HookForm />;
  else if (section === "hooks" && route[1] && route[2] === "edit") page = <HookForm id={route[1]} />;
  else if (section === "hooks" && route[1]) page = <HookDetail id={route[1]} />;
  else if (section === "projects" && route[1] === "new") page = <ProjectForm />;
  else if (section === "projects" && route[1] && route[2] === "edit") page = <ProjectForm id={route[1]} />;
  else if (section === "projects") page = <MyProjects />;
  else if (section === "explore") page = <Leaderboard />;
  else if (section === "payments") page = <PaymentLinks />;
  else if (section === "p" && route[1]) page = <ProjectPage slug={route[1]} />;
  else if (section === "telegram") page = <TelegramPage />;
  else if (section === "keys") page = <Keys />;
  else if (section === "billing") page = <Billing />;
  else if (section === "status") page = <StatusPage />;
  else if (section === "docs") page = <Docs />;
  else page = <Hooks />;

  return (
    <div className="shell">
      <aside className="side">
        <a className="brand" href="#/hooks">
          <img src="/favicon.svg" alt="" /> QIE Pulse
        </a>
        <nav className="nav stack" style={{ gap: 2 }}>
          {NAV.map((n) => (
            <a key={n.path} href={`#/${n.path}`} className={section === n.path || (n.path === "explore" && section === "p") ? "active" : ""}>
              <span aria-hidden>{n.icon}</span> {n.label}
            </a>
          ))}
        </nav>
        <div className="spacer" />
        {me && (
          <div className="stack small account" style={{ gap: 6, padding: "0 8px" }}>
            <div>
              <div style={{ fontWeight: 600 }}>{me.user.qieName ?? shortAddr(me.user.address)}</div>
              <div className="faint mono addr">{shortAddr(me.user.address)}</div>
            </div>
            <div className="row">
              <span className={`badge ${me.plan.id === "pro" ? "accent" : ""}`}>{me.plan.label}</span>
              <button
                className="btn sm ghost"
                onClick={async () => {
                  await api("POST", "/auth/logout");
                  setMe(null);
                  go("/");
                }}
              >
                Sign out
              </button>
            </div>
          </div>
        )}
      </aside>
      <main className="main">{page}</main>
    </div>
  );
}

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [booted, setBooted] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const route = useRoute();

  const reloadMe = async () => {
    try {
      setMe(await api<Me>("GET", "/me"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setMe(null);
      else throw e;
    }
  };

  useEffect(() => {
    (async () => {
      try {
        setConfig(await api<AppConfig>("GET", "/config"));
        await reloadMe();
      } catch (e) {
        setBootError(e instanceof Error ? e.message : String(e));
      } finally {
        setBooted(true);
      }
    })();
  }, []);

  if (!booted) {
    return (
      <div className="empty">
        <Spinner />
      </div>
    );
  }
  if (!config) return <div className="empty">Could not reach the QIE Pulse server: {bootError}</div>;

  const publicPage = ["status", "docs", "explore", "p"].includes(route[0] ?? "");
  // The customer-facing checkout stands alone: no dashboard around it.
  if (route[0] === "pay" && route[1]) {
    return (
      <AppCtx.Provider value={{ config, me, reloadMe, setMe }}>
        <Checkout id={route[1]} />
      </AppCtx.Provider>
    );
  }
  return (
    <AppCtx.Provider value={{ config, me, reloadMe, setMe }}>
      {me || publicPage ? <Shell route={me ? route : route} /> : <Landing />}
    </AppCtx.Provider>
  );
}
