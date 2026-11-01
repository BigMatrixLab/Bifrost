import { useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  FolderOpen,
  KeyRound,
  Link2,
  Lock,
  Monitor,
  RefreshCw,
  ShieldCheck,
  Waypoints,
  Wifi,
  Zap,
} from "lucide-react";
import {
  PERMISSION_OPTIONS,
  android,
  api,
  canUpload,
  errorText,
  on,
  permissionHint,
  permissionText,
  type CreatedInvitation,
  type JoinResult,
  type Share,
  type SharePermission,
} from "./api";
import { isAndroid } from "./platform";
import { neverExpires, until } from "./format";
import { useStore } from "./store";
import { Button, CodeCells, Modal, Progress, SafetyWords, Segmented, Toggle } from "./ui";

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      icon={done ? <Check size={14} /> : <Copy size={14} />}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        window.setTimeout(() => setDone(false), 1600);
      }}
    >
      {done ? "Copied" : label}
    </Button>
  );
}

// ---------------------------------------------------------------- invite

export function InviteDialog({ share, onClose }: { share: Share; onClose: () => void }) {
  const { toast, settings } = useStore();
  const [expires, setExpires] = useState(86400);
  const [uses, setUses] = useState<number>(1);
  const [approval, setApproval] = useState(true);
  const [perm, setPerm] = useState<SharePermission>(settings?.defaultSharePermission ?? "download");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedInvitation | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    if (!created) return;
    const t = window.setInterval(() => tick((x) => x + 1), 1000);
    return () => window.clearInterval(t);
  }, [created]);

  const create = async () => {
    setBusy(true);
    try {
      // The 16-character code is the invitation people share; it lives as long as the invitation.
      // Devices that join with it get exactly this permission.
      setCreated(await api.createInvitation(share.id, expires, uses === 0 ? null : uses, approval, true, perm));
    } catch (e) {
      toast(errorText(e), "err");
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    const inv = created.invitation;
    const now = Date.now();
    const never = neverExpires(inv.expiresAt);
    // Share of the invitation's lifetime left; the meter turns from green
    // through yellow to red as it runs out.
    const left = never ? 1 : Math.max(0, Math.min(1, (inv.expiresAt - now) / Math.max(1, inv.expiresAt - inv.createdAt)));
    const tone = left > 0.5 ? "ok" : left > 0.2 ? "warn" : "err";
    const usesText = inv.maxUses != null ? `${inv.useCount} / ${inv.maxUses} uses` : "Unlimited uses";
    return (
      <Modal title={`Invite to “${share.name}”`} onClose={onClose} width={680} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <div className="inv-chips" aria-label="Invitation settings">
          <span className={`inv-chip ${canUpload(perm) ? "on" : ""}`}>{permissionText(perm)}</span>
          <span className="inv-chip">{usesText}</span>
          <span className={`inv-chip ${inv.requireApproval ? "on" : ""}`}>{inv.requireApproval ? "Approval on" : "No approval"}</span>
        </div>

        <div className="inv-grid">
          <figure className="qr-scan" aria-label="Invitation QR code">
            <span className="qr-frame">
              {/* The beam lives inside the QR box, which clips it to the code. */}
              <span className="qr-box">
                <span className="qr" dangerouslySetInnerHTML={{ __html: created.qrSvg }} />
                <span className="qr-beam" aria-hidden="true" />
              </span>
            </span>
            <figcaption>Scan to get the code</figcaption>
          </figure>

          <div className="inv-code">
            <span className="lab">Invitation code</span>
            {created.shortCode ? (
              <>
                <CodeCells code={created.shortCode} />
                <CopyButton text={created.shortCode} label="Copy code" />
              </>
            ) : (
              // Only without a lookup service (offline test mode): the full invitation.
              <>
                <div className="code-box inv-long">
                  <span className="val selectable">{created.invite}</span>
                </div>
                <CopyButton text={created.invite} label="Copy invitation" />
              </>
            )}
            <div className={`inv-life tone-${never ? "ok" : tone}`}>
              <div className="inv-life-head">
                <span className="lab">{never ? "Valid" : "Valid for"}</span>
                <span className="num">{never ? "Until you revoke it" : until(inv.expiresAt).replace(/^in /, "")}</span>
              </div>
              <Progress value={left} tone={never ? "ok" : tone} />
            </div>
            <span className="hint">
              Send it in any chat app, read it out, or let them scan it. They enter it in Bifrost under Receive. It works while Bifrost is open and online here.
            </span>
          </div>
        </div>

        <div className="inv-status">
          <span className="inv-pulse" aria-hidden="true" />
          <span>
            <b>Waiting for them to connect.</b> Keep this computer on and Bifrost open while they download.
            {inv.requireApproval && " You'll approve their device first."}
          </span>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={`Invite someone to “${share.name}”`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={create} icon={<Link2 size={15} />}>
            Create invitation
          </Button>
        </>
      }
    >
      <div className="field">
        <span className="label">Devices joining with this invitation can</span>
        <Segmented full label="Permission" value={perm} onChange={setPerm} options={PERMISSION_OPTIONS} />
        <span className="hint">
          {permissionHint(perm)} Only devices that join with this invitation get it; others keep their own access. You can change it per
          device any time on the Send page.
        </span>
      </div>
      <div className="field">
        <span className="label">Invitation expires</span>
        <Segmented
          full
          label="Expiry"
          value={expires}
          onChange={setExpires}
          options={[
            { value: 3600, label: "1 hour" },
            { value: 86400, label: "24 hours" },
            { value: 7 * 86400, label: "7 days" },
            { value: 0, label: "Never" },
          ]}
        />
        {expires === 0 && (
          <span className="hint warn-text">
            The invitation keeps working until you revoke it on the Send page. Anyone who gets hold of it can ask for access
            {approval ? ", but you still approve each device." : ". Turn on approval below to stay in control."}
          </span>
        )}
      </div>
      <div className="field">
        <span className="label">Can be used by</span>
        <Segmented
          full
          label="Uses"
          value={uses}
          onChange={setUses}
          options={[
            { value: 1, label: "1 device" },
            { value: 5, label: "Up to 5" },
            { value: 0, label: "Unlimited" },
          ]}
        />
        <span className="hint">Once a device has joined, it keeps access until you remove it, even after the invitation expires.</span>
      </div>
      <div>
        <Toggle checked={approval} onChange={setApproval} label="Ask me to approve each device" hint="Recommended. You'll see the device name before it can browse anything." />
      </div>
      <div className="notice">
        <Lock size={16} />
        <span>
          {perm === "download" && <>They can only see and download from <b>{share.name}</b>. Nothing outside this folder is reachable, and they can't change or delete anything.</>}
          {perm === "upload" && <>They can only add files to <b>{share.name}</b>. They can't see or download your files, and can delete only what they uploaded.</>}
          {perm === "both" && <>They can download from and add files to <b>{share.name}</b>. Nothing outside this folder is reachable, and they can delete only what they uploaded; your files stay untouched.</>}
        </span>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- connect

/** Characters invitation codes use (core: invite::CODE_ALPHABET). */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const CODE_LEN = 16;

/** Letters and digits of what was typed, upper case, at most 16. */
function codeChars(s: string) {
  return s.replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, CODE_LEN);
}

/** A complete 16-character code that only uses characters codes can contain. */
function codeReady(s: string) {
  const c = codeChars(s);
  return c.length === CODE_LEN && c.split("").every((ch) => CODE_ALPHABET.includes(ch));
}

/** "K7QM9XRT4H" -> "K7QM 9XRT 4H" */
function groupCode(chars: string) {
  return (chars.match(/.{1,4}/g) ?? []).join(" ");
}

/**
 * The invitation code as 16 equal cells in four groups of four. Typing or
 * pasting fills them in order and stops at 16; spaces, dashes and lower case
 * are handled. Every letter and digit can be typed; ones codes never contain
 * (I, L, O, U, 0, 1) are marked so a misread code is caught before connecting.
 */
function CodeEntry({ value, onChange, onSubmit }: { value: string; onChange: (v: string) => void; onSubmit: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const chars = codeChars(value);
  const bad = chars.split("").filter((c) => !CODE_ALPHABET.includes(c));

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  // Anything past the 16th character is ignored.
  const set = (raw: string) => onChange(groupCode(codeChars(raw)));
  const keepCaretAtEnd = () => {
    const el = ref.current;
    if (el) el.setSelectionRange(el.value.length, el.value.length);
  };

  return (
    <>
      <div className={`code-entry ${focused ? "focused" : ""}`} onMouseDown={(e) => { e.preventDefault(); ref.current?.focus(); }}>
        <div className="ce-groups" aria-hidden="true">
          {[0, 1, 2, 3].map((g) => (
            <span className="ce-group" key={g}>
              {[0, 1, 2, 3].map((c) => {
                const i = g * 4 + c;
                const ch = chars[i];
                // The next cell to fill shows a blinking caret.
                const cur = focused && i === chars.length;
                return (
                  <i key={c} className={`${ch ? (CODE_ALPHABET.includes(ch) ? "on" : "bad") : ""} ${cur ? "cur" : ""}`}>
                    {ch ?? ""}
                  </i>
                );
              })}
            </span>
          ))}
        </div>
        <input
          id="inv"
          ref={ref}
          className="ce-input"
          value={value}
          onChange={(e) => set(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onSelect={keepCaretAtEnd}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onSubmit();
            }
          }}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={CODE_LEN + 3}
          aria-label="Invitation code, 16 characters"
        />
      </div>
      <span className={`hint ${bad.length ? "warn-text" : ""}`}>
        {bad.length
          ? `Invitation codes never contain ${Array.from(new Set(bad)).join(", ")} (Bifrost leaves out I, L, O, U, 0 and 1 because they're easy to mix up). Check the marked characters with the sender.`
          : `${chars.length} of ${CODE_LEN} · Codes look like K7QM-9XRT-4HWD-P2NA. Type or paste it.`}
      </span>
    </>
  );
}

export function ConnectDialog({ onClose }: { onClose: () => void }) {
  const { openBrowser, toast } = useStore();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<JoinResult | null>(null);
  const [words, setWords] = useState<string[] | null>(null);

  useEffect(() => {
    const u = on<{ message: string; safetyWords?: string[] | null }>("join-status", (p) => {
      setStatus(p.message);
      if (p.safetyWords?.length) setWords(p.safetyWords);
    });
    return () => {
      u.then((f) => f());
    };
  }, []);

  const join = async () => {
    setBusy(true);
    setError(null);
    setStatus("Connecting…");
    try {
      const r = await api.join(input);
      setResult(r);
      toast(`Paired with ${r.senderName}`, "ok");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      setStatus(null);
    }
  };

  if (result) {
    return (
      <Modal title={`Connected to ${result.senderName}`} onClose={onClose}>
        <div className="notice accent">
          <ShieldCheck size={16} />
          <span>This device is now trusted by <b>{result.senderName}</b>. You can come back any time without a new invitation.</span>
        </div>
        {result.safetyWords?.length > 0 && (
          <div className="words-block">
            <span className="label">Safety words</span>
            <SafetyWords words={result.safetyWords} />
            <span className="hint">{result.senderName} sees the same five words for this connection. If they differ, someone is in between: forget the device and pair again.</span>
          </div>
        )}
        <div className="stack" style={{ gap: 8 }}>
          <span className="label">Shared with you</span>
          {result.shares.map((s) => (
            <button
              key={s.id}
              className="hero-tile"
              onClick={() => {
                openBrowser({ peerId: result.peerId, shareId: s.id, shareName: s.name, peerName: result.senderName });
                onClose();
              }}
            >
              <span className="ico" style={{ width: 38, height: 38 }}><FolderOpen size={18} /></span>
              <span className="stack grow">
                <span className="t" style={{ fontSize: 14 }}>{s.name}</span>
                <span className="d">
                  {s.permission === "upload" ? "Add files" : s.permission === "both" ? "Browse, download and add files" : "Browse and choose files"}
                </span>
              </span>
            </button>
          ))}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="Connect with a code"
      width={460}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!codeReady(input)} onClick={join} icon={<KeyRound size={15} />}>
            Connect
          </Button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="inv">Invitation code</label>
        <CodeEntry value={input} onChange={setInput} onSubmit={() => codeReady(input) && !busy && join()} />
      </div>
      {busy && status && (
        <div className="notice accent">
          <RefreshCw size={16} className="spin" />
          <span>{status}</span>
        </div>
      )}
      {busy && words && (
        <div className="words-block">
          <span className="label">Safety words</span>
          <SafetyWords words={words} />
          <span className="hint">Read these to the sender. They should see the same five words before they approve this device.</span>
        </div>
      )}
      {error && (
        <div className="notice err">
          <Wifi size={16} />
          <span>{error}</span>
        </div>
      )}
      {!busy && !error && (
        <span className="hint">
          Your computer verifies the sender's identity cryptographically. Files travel directly between the two computers, end-to-end encrypted.
        </span>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- approvals

export function AccessRequests() {
  const { pending, toast } = useStore();
  const req = pending[0];
  if (!req) return null;
  const respond = async (approve: boolean) => {
    try {
      await api.respondAccess(req.id, approve);
      toast(approve ? `${req.deviceName} can now open “${req.shareName}”` : "Request declined", approve ? "ok" : "info");
    } catch (e) {
      toast(errorText(e), "err");
    }
  };
  return (
    <Modal
      title="A device wants access"
      onClose={() => respond(false)}
      footer={
        <>
          <Button variant="ghost" onClick={() => respond(false)}>Decline</Button>
          <Button variant="primary" onClick={() => respond(true)} icon={<Check size={15} />}>Allow access</Button>
        </>
      }
    >
      <div className="hstack" style={{ gap: 14 }}>
        <div className="share-ico"><Monitor size={20} /></div>
        <div className="stack">
          <b style={{ fontSize: 15 }}>{req.deviceName}</b>
          <span className="faint small mono">Device ID {req.peerShort}…</span>
        </div>
      </div>
      <span>
        used your invitation and wants to open <b>“{req.shareName}”</b>. Only allow devices you expect.
      </span>
      <div className="notice">
        <Lock size={16} />
        <span>
          <b>{permissionText(req.permission)}</b>, as set in the invitation. {permissionHint(req.permission)} You can change it later on the
          Send page.
        </span>
      </div>
      {req.safetyWords?.length > 0 && (
        <div className="words-block">
          <span className="label">Safety words</span>
          <SafetyWords words={req.safetyWords} />
          <span className="hint">Ask them which words their screen shows. Allow only if all five match; different words mean someone else is answering.</span>
        </div>
      )}
      {pending.length > 1 && <span className="hint">{pending.length - 1} more request(s) waiting.</span>}
    </Modal>
  );
}

// ---------------------------------------------------------------- onboarding

export function Onboarding() {
  const { settings, saveSettings } = useStore();
  const [name, setName] = useState(settings?.deviceName ?? "");
  if (!settings || settings.onboarded) return null;
  const done = () => {
    if (isAndroid()) {
      android.requestNotificationPermission().catch(() => {});
    }
    return saveSettings({ ...settings, deviceName: name.trim() || settings.deviceName, onboarded: true });
  };
  return (
    <Modal title="Welcome to Bifrost" onClose={done} width={560} footer={<Button variant="primary" onClick={done}>Get started</Button>}>
      <div className="onboard-points">
        <div className="onboard-point">
          <span className="i"><Zap size={16} /></span>
          <span><b>Your files never sit on a server</b><span className="muted">Files go straight from the sender's device to yours, end-to-end encrypted. No account, no upload, no cloud copy.</span></span>
        </div>
        <div className="onboard-point">
          <span className="i"><Waypoints size={16} /></span>
          <span><b>A small coordination service helps you find each other</b><span className="muted">Public iroh relays and DNS exchange connection details so the two devices can punch through routers. If a router blocks a direct path, a relay forwards the end-to-end encrypted data; it can't read or keep it, and the receipt shows how much went that way. You can choose direct only in Settings.</span></span>
        </div>
        <div className="onboard-point">
          <span className="i"><ShieldCheck size={16} /></span>
          <span><b>Proof stays with you</b><span className="muted">Every finished transfer gets a privacy receipt: the route it took, how it was verified, and what servers kept (nothing). Your history never leaves this device.</span></span>
        </div>
        <div className="onboard-point">
          <span className="i"><RefreshCw size={16} /></span>
          <span><b>Interruptions don't lose progress</b><span className="muted">Both devices need to be online while a transfer runs. If either drops, restarts or reboots, the download continues from its last verified piece.{isAndroid() ? " On Android a notification shows while files are moving so the transfer keeps running with the screen off." : ""}</span></span>
        </div>
      </div>
      <div className="field">
        <label htmlFor="dn">{isAndroid() ? "This device's name" : "This computer's name"}</label>
        <input id="dn" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
        <span className="hint">Shown to people you share with or connect to.</span>
      </div>
    </Modal>
  );
}
