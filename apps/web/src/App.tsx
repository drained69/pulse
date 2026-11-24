import { createContext, useContext, useEffect, useState } from "react";
import { api, ApiError, type AppConfig, type Me } from "./api.ts";
import { Billing } from "./pages/Billing.tsx";
import { Docs } from "./pages/Docs.tsx";
import { Guide } from "./pages/Guide.tsx";
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
  { path: "", label: "Home" },
  { path: "hooks", label: "Hooks" },
  { path: "payments", label: "Payment links" },
  { path: "projects", label: "Traction" },
  { path: "explore", label: "Leaderboard" },
  { path: "status", label: "Status" },
  { path: "guide", label: "Guide" },
  { path: "docs", label: "Docs" },
];
const PUBLIC_NAV = [
  { path: "", label: "Home" },
  { path: "guide", label: "How it works" },
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
          disabled={busy}
          onClick={async () => {
            setError(null);
            setBusy(true);
            try {
              await api("POST", "/auth/logout");
              closeMenus();
              setMe(null);
              go("/");
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Signing out…" : "Sign out"}
        </button>
        {error && <p className="menu-error" role="alert">{error}</p>}
      </div>
    </details>
  );
}

/** Floating pill header shared by the dashboard, public pages and the landing page. */
export function SiteHeader({ section = "" }: { section?: string }) {
  const { me } = useApp();
  const items = me ? NAV : PUBLIC_NAV;
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.("details.menu")) closeMenus();
      if (!(e.target as Element).closest?.(".header")) setNavOpen(false);
    };
    const onRoute = () => { closeMenus(); setNavOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const account = document.querySelector<HTMLDetailsElement>("details.menu[open]");
      if (account) {
        account.removeAttribute("open");
        account.querySelector<HTMLElement>("summary")?.focus();
      }
      setNavOpen(false);
      if (document.activeElement?.closest(".nav")) document.querySelector<HTMLButtonElement>(".nav-toggle")?.focus();
    };
    document.addEventListener("click", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("hashchange", onRoute);
    return () => {
      document.removeEventListener("click", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("hashchange", onRoute);
    };
  }, []);
  return (
    <div className="header-wrap">
      <button className="skip-link" type="button" onClick={() => document.getElementById("main-content")?.focus()}>Skip to content</button>
      <header className="header">
        <a className="brand" href="#/" aria-label="Q-Pulse home">
          <img src="/favicon.svg" alt="" /> Q-Pulse
        </a>
        <nav id="main-navigation" className={`nav ${navOpen ? "is-open" : ""}`} aria-label="Main">
          {items.map((n) => (
            <a key={n.path} href={`#/${n.path}`} aria-current={isActive(section, n.path) ? "page" : undefined} className={isActive(section, n.path) ? "active" : ""} onClick={() => setNavOpen(false)}>
              {n.label}
            </a>
          ))}
          {!me && <div className="mobile-signin"><SignInButton label="Get started" next="/hooks" compact /></div>}
        </nav>
        <div className="header-end">
          <ThemeToggle />
          {me ? <AccountMenu section={section} /> : <span className="header-signin"><SignInButton label="Get started" next="/hooks" compact /></span>}
          <button className="nav-toggle" type="button" aria-expanded={navOpen} aria-controls="main-navigation" aria-label={navOpen ? "Close navigation" : "Open navigation"} onClick={() => setNavOpen(!navOpen)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d={navOpen ? "M6 6l12 12M6 18 18 6" : "M4 7h16M4 12h16M4 17h16"} /></svg>
          </button>
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
          <a href="#/guide">Guide</a>
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
  else if (section === "guide") page = <Guide section={route[1]} />;
  else if (section === "terms") page = <Terms />;
  else if (section === "privacy") page = <Privacy />;
  else if (section === "hooks") page = <Hooks />;
  else page = (
    <div className="empty">
      <h1>Page not found</h1>
      <p>This link doesn’t point to a Q-Pulse page.</p>
      <a className="btn primary" href="#/">Back to Home</a>
    </div>
  );

  return (
    <div className="app">
      <SiteHeader section={section} />
      <main id="main-content" className="main" tabIndex={-1}><div key={route.join("/")}>{page}</div></main>
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
  useEffect(() => {
    document.getElementById("main-content")?.focus({ preventScroll: true });
  }, [route]);

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
  if (!config) return (
    <main className="empty boot-error">
      <a className="brand" href="#/"><img src="/favicon.svg" alt="" /> Q-Pulse</a>
      <h1>We couldn’t load Q-Pulse</h1>
      <p>Please try again in a moment.</p>
      <p className="small" role="alert">{bootError}</p>
      <button className="btn primary" type="button" onClick={() => window.location.reload()}>Try again</button>
    </main>
  );

  const section = route[0] ?? "";
  const knownPage = ["", "home", "hooks", "payments", "projects", "explore", "p", "telegram", "keys", "billing", "status", "docs", "guide", "terms", "privacy", "pay", "buy", "device"].includes(section);
  const publicPage = !knownPage || ["status", "docs", "guide", "explore", "p", "terms", "privacy"].includes(section);
  // The customer-facing checkout stands alone: no dashboard around it.
  if (["pay", "buy", "device"].includes(route[0] ?? "") && route[1]) {
    const id = route[1];
    return (
      <AppCtx.Provider value={{ config, me, reloadMe, setMe }}>
        {route[0] === "pay" ? <Checkout key={id} id={id} /> : route[0] === "buy" ? <BuyPage key={id} id={id} /> : <DevicePage key={id} id={id} />}
      </AppCtx.Provider>
    );
  }
  return (
    <AppCtx.Provider value={{ config, me, reloadMe, setMe }}>
      {route.length === 0 || route[0] === "home" || (!me && !publicPage) ? <Landing /> : <Shell route={route} />}
    </AppCtx.Provider>
  );
}
