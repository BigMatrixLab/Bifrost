/**
 * Settings → Connection: "Allow direct connections". Windows Firewall has to
 * accept the other device's packets for a direct path; its first-launch
 * prompt often leaves Bifrost blocked or allowed on only some networks. The
 * check reads the rules (no admin); the button fixes them with one Windows
 * administrator prompt. Desktop Windows only; elsewhere this renders nothing.
 */
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Info, Settings as SettingsIcon, ShieldAlert, ShieldCheck, Zap } from "lucide-react";
import { api, errorText, type FirewallStatus } from "./api";
import { useStore } from "./store";
import { Button, Modal } from "./ui";
import { isAndroid } from "./platform";

/** Set once the first-run prompt has been answered, so it never asks again. */
const ASKED_KEY = "bifrost-fw-asked";
const asked = () => {
  try {
    return localStorage.getItem(ASKED_KEY) === "1";
  } catch {
    return false;
  }
};
const markAsked = () => {
  try {
    localStorage.setItem(ASKED_KEY, "1");
  } catch {
    /* storage unavailable: it may ask again next start */
  }
};

/** Settings → Connection, scrolled to the "Allow direct connections" row. */
export function openFirewallSetting(setPage: (p: "settings") => void) {
  setPage("settings");
  let tries = 0;
  const go = () => {
    const el = document.getElementById("allow-direct");
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("fw-flash");
      window.setTimeout(() => el.classList.remove("fw-flash"), 2400);
    } else if (tries++ < 20) window.setTimeout(go, 100);
  };
  window.setTimeout(go, 50);
}

/**
 * First run (Windows): asks once, after the welcome screen, whether to allow
 * direct connections. Declining, or cancelling the Windows prompt, shows
 * where to turn it on later. Not shown when the firewall already allows it.
 */
export function FirewallPrompt() {
  const { settings, setPage, toast } = useStore();
  const [st, setSt] = useState<FirewallStatus | null>(null);
  const [step, setStep] = useState<"ask" | "later" | "closed">(() =>
    // Demo build only (screenshots): ?open=fw-later opens the second step.
    import.meta.env.MODE === "mock" && new URLSearchParams(location.search).get("open") === "fw-later" ? "later" : asked() ? "closed" : "ask",
  );
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const ready = !!settings?.onboarded && !isAndroid() && step !== "closed";

  useEffect(() => {
    if (!ready || st) return;
    api.firewallStatus().then(setSt).catch(() => setStep("closed"));
  }, [ready, st]);

  if (!ready || !st || !st.supported || (st.allowed && step === "ask")) return null;

  const close = () => {
    markAsked();
    setStep("closed");
  };
  const allow = async () => {
    setBusy(true);
    try {
      const s = await api.allowDirectConnections();
      if (s.allowed) {
        toast("Direct connections are allowed in Windows Firewall.", "ok");
        close();
      } else {
        setFailed("Windows Firewall still blocks Bifrost.");
        setStep("later");
      }
    } catch (e) {
      setFailed(errorText(e));
      setStep("later");
    } finally {
      setBusy(false);
    }
  };

  if (step === "later") {
    return (
      <Modal
        title="You can allow it later"
        onClose={close}
        width={520}
        footer={
          <>
            <Button variant="ghost" onClick={close}>OK</Button>
            <Button
              icon={<SettingsIcon size={15} />}
              onClick={() => {
                close();
                openFirewallSetting(setPage);
              }}
            >
              Show me where
            </Button>
          </>
        }
      >
        {failed && (
          <div className="space-msg lv-warn" role="status">
            <Info size={16} />
            <span>{failed}</span>
          </div>
        )}
        <span>
          Transfers still work: when Windows Firewall blocks a direct path, they go through an encrypted relay, which can be slower. To allow direct
          connections any time, open
        </span>
        <div className="fw-path">
          <b>Settings</b>
          <span>›</span>
          <b>Connection</b>
          <span>›</span>
          <b>Allow direct connections</b>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="Allow direct connections?"
      onClose={() => setStep("later")}
      width={540}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={() => setStep("later")}>Not now</Button>
          <Button variant="primary" loading={busy} icon={<ShieldCheck size={15} />} onClick={allow}>Allow</Button>
        </>
      }
    >
      <div className="onboard-points">
        <div className="onboard-point">
          <span className="i"><Zap size={16} /></span>
          <span>
            <b>Faster transfers, straight between computers</b>
            <span className="muted">
              Windows Firewall {st.blocked > 0 ? "blocks Bifrost" : "only lets Bifrost in on some networks"}, so transfers often go through a slower relay
              instead.
            </span>
          </span>
        </div>
        <div className="onboard-point">
          <span className="i"><ShieldCheck size={16} /></span>
          <span>
            <b>One rule, only for Bifrost</b>
            <span className="muted">
              Adds a firewall rule that lets other devices reach Bifrost (UDP, on home, work and public networks). Connections stay end-to-end encrypted, and
              only devices you paired can use them.
            </span>
          </span>
        </div>
      </div>
      <span className="hint">Windows asks for administrator permission once.</span>
    </Modal>
  );
}

export function FirewallRow() {
  const { toast } = useStore();
  const [st, setSt] = useState<FirewallStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = useCallback(() => {
    setErr(null);
    api.firewallStatus().then(setSt).catch((e) => setErr(errorText(e)));
  }, []);
  useEffect(check, [check]);

  if (st && !st.supported) return null;

  const allow = async () => {
    setBusy(true);
    try {
      const s = await api.allowDirectConnections();
      setSt(s);
      toast(s.allowed ? "Direct connections are allowed in Windows Firewall." : "Windows Firewall still blocks Bifrost.", s.allowed ? "ok" : "err");
    } catch (e) {
      toast(errorText(e), "err");
    } finally {
      setBusy(false);
    }
  };

  const tone = !st ? "unknown" : st.allowed ? "ok" : st.blocked > 0 ? "err" : "warn";
  const text = err
    ? "Couldn't read the Windows Firewall rules."
    : !st
      ? "Checking Windows Firewall…"
      : st.allowed
        ? "Allowed on every network. Other devices can reach this computer directly."
        : st.blocked > 0
          ? "Windows Firewall blocks Bifrost, so transfers go through a relay."
          : "Not allowed on every network type, so some networks fall back to a relay.";

  return (
    <div className="setting fw-row" id="allow-direct">
      <div className="stack">
        <span className="label">Allow direct connections</span>
        <span className="hint">
          Adds one Windows Firewall rule that lets other devices reach Bifrost directly (UDP, on home, work and public networks), and removes
          rules that block it. Windows asks for administrator permission once.
        </span>
        <span className={`fw-state tone-${tone}`} role="status">
          {tone === "ok" ? <ShieldCheck size={14} /> : tone === "unknown" ? null : <ShieldAlert size={14} />}
          {text}
        </span>
      </div>
      <div>
        {st?.allowed ? (
          <span className="fw-done">
            <CheckCircle2 size={15} /> Allowed
          </span>
        ) : (
          <Button variant="primary" loading={busy} disabled={!st && !err} onClick={allow}>
            Allow
          </Button>
        )}
      </div>
    </div>
  );
}
