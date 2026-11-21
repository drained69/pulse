import { createContext, useContext, useEffect, useState } from "react";
import { api, ApiError, type AppConfig, type Me } from "./api.ts";
import { Billing } from "./pages/Billing.tsx";
import { Docs } from "./pages/Docs.tsx";
import { HookDetail } from "./pages/HookDetail.tsx";
import { HookForm } from "./pages/HookForm.tsx";
import { Hooks } from "./pages/Hooks.tsx";
import { Keys } from "./pages/Keys.tsx";
import { Landing, SignInButton } from "./pages/Landing.tsx";
import { Privacy, Terms } from "./pages/Legal.tsx";
import { Checkout, PaymentLinks } from "./pages/Pay.tsx";
import { BuyPage, DevicePage } from "./pages/Shop.tsx";
import { Leaderboard, MyProjects, ProjectForm, ProjectPage } from "./pages/Traction.tsx";
import { StatusPage } from "./pages/Status.tsx";
import { TelegramPage } from "./pages/Telegram.tsx";
import { shortAddr, Spinner, ThemeToggle } from "./ui.tsx";

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
  { path: "hooks", label: "Hooks" },
  { path: "payments", label: "Payment links" },
  { path: "projects", label: "Traction" },
  { path: "explore", label: "Leaderboard" },
  { path: "status", label: "Status" },
  { path: "docs", label: "Docs" },
];
const PUBLIC_NAV = [
  { path: "explore", label: "Leaderboard" },
  { path: "status", label: "Network status" },
  { path: "docs", label: "Docs" },
];
const ACCOUNT_NAV = [
  { path: "telegram", label: "Telegram" },
  { path: "keys", label: "API keys" },
  { path: "billing", label: "Plan" },
];

function isActive(section: string, path: string): boolean {
  return section === path || (path === "explore" && section === "p") || (path === "payments" && section === "pay");
}

function closeMenus() {
  document.querySelectorAll("details.menu[open]").forEach((d) => d.removeAttribute("open"));
}

function AccountMenu({ section }: { section: string }) {
  const { me, setMe } = useApp();
  if (!me) return null;
  const name = me.user.qieName ?? shortAddr(me.user.address);
  return (
    <details className="menu">
      <summary aria-label="Account menu">
        <span className="avatar" aria-hidden /> <span className="label">{name}</span>
      </summary>
      <div className="menu-panel">
        <div className="who">
          <div style={{ fontWeight: 600, color: "var(--ink)" }}>{name}</div>
          <div className="faint mono small">{shortAddr(me.user.address)}</div>
        </div>
        {ACCOUNT_NAV.map((n) => (
          <a key={n.path} href={`#/${n.path}`} className={isActive(section, n.path) ? "active" : ""} onClick={closeMenus}>
            {n.label}
            {n.path === "billing" && <span className={`badge ${me.plan.id === "pro" ? "accent" : ""}`}>{me.plan.label}</span>}
          </a>
        ))}
        <button
          type="button"
          onClick={async () => {
            closeMenus();
            await api("POST", "/auth/logout");
            setMe(null);
            go("/");
          }}
        >
          Sign out
        </button>
      </div>
    </details>
  );
}

/** Floating pill header shared by the dashboard, public pages and the landing page. */
export function SiteHeader({ section = "" }: { section?: string }) {
  const { me } = useApp();
  const items = me ? NAV : PUBLIC_NAV;
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.("details.menu")) closeMenus();
    };
    document.addEventListener("click", onDoc);
    window.addEventListener("hashchange", closeMenus);
    return () => {
      document.removeEventListener("click", onDoc);
      window.removeEventListener("hashchange", closeMenus);
    };
  }, []);
  return (
    <div className="header-wrap">
      <header className="header">
        <a className="brand" href={me ? "#/hooks" : "#/"}>
          <img src="/favicon.svg" alt="" /> Q-Pulse
        </a>
        <nav className="nav" aria-label="Main">
          {items.map((n) => (
            <a key={n.path} href={`#/${n.path}`} className={isActive(section, n.path) ? "active" : ""}>
              {n.label}
            </a>
          ))}
        </nav>
        <div className="header-end">
          <ThemeToggle />
          {me ? <AccountMenu section={section} /> : <SignInButton label="Get started" next="/hooks" compact />}
        </div>
      </header>
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <a className="brand" href="#/" style={{ fontSize: "1.1rem" }}>
          <img src="/favicon.svg" alt="" style={{ width: 22, height: 22 }} /> Q-Pulse
        </a>
        <span>Real-time events, payments and provable traction for QIE Blockchain.</span>
        <span className="links">
          <a href="#/docs">Docs</a>
          <a href="#/status">Status</a>
          <a href="#/explore">Leaderboard</a>
          <a href="#/terms">Terms</a>
          <a href="#/privacy">Privacy</a>
          <a href="https://github.com/drained69/pulse" target="_blank" rel="noreferrer">
            GitHub
          </a>
        </span>
      </div>
    </footer>
  );
}

function Shell({ route }: { route: string[] }) {
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
  else if (section === "terms") page = <Terms />;
  else if (section === "privacy") page = <Privacy />;
  else page = <Hooks />;

  return (
    <div className="app">
      <SiteHeader section={section} />
      <main className="main">{page}</main>
      <SiteFooter />
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
  if (!config) return <div className="empty">Could not reach the Q-Pulse server: {bootError}</div>;

  const publicPage = ["status", "docs", "explore", "p", "terms", "privacy"].includes(route[0] ?? "");
  // The customer-facing checkout stands alone: no dashboard around it.
  if (["pay", "buy", "device"].includes(route[0] ?? "") && route[1]) {
    const id = route[1];
    return (
      <AppCtx.Provider value={{ config, me, reloadMe, setMe }}>
        {route[0] === "pay" ? <Checkout id={id} /> : route[0] === "buy" ? <BuyPage id={id} /> : <DevicePage id={id} />}
      </AppCtx.Provider>
    );
  }
  return (
    <AppCtx.Provider value={{ config, me, reloadMe, setMe }}>
      {me || publicPage ? <Shell route={route} /> : <Landing />}
    </AppCtx.Provider>
  );
}
