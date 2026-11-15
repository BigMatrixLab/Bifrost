import { useEffect, useState } from "react";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { BatteryCharging, Bell, Copy, FolderLock, Info, Lock } from "lucide-react";
import { PERMISSION_OPTIONS, android, api, errorText, permissionHint, type Settings as S } from "../api";
import { isAndroid, pickFolder } from "../platform";
import { useStorageAccess } from "../android";
import { mbit } from "../format";
import { useStore } from "../store";
import { Button, Modal, Segmented, Toggle } from "../ui";
import { PlateMenu, Win } from "../glass";

function Row({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="setting">
      <div className="stack">
        <span className="label">{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </div>
      <div>{children}</div>
    </div>
  );
}

// `value` is KiB/s (0 = unlimited); shown as MB/s with up to two decimals.
// A limit below 0.01 MB/s shows as 0.01 rather than "0".
const kibToMbText = (kib: number) => (kib ? String(Math.max(0.01, Number((kib / 1024).toFixed(2)))) : "");

function LimitInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(kibToMbText(value));
  useEffect(() => setText(kibToMbText(value)), [value]);
  return (
    <div className="hstack">
      <input
        className="input num"
        inputMode="numeric"
        placeholder="Unlimited"
        value={text}
        onChange={(e) => setText(e.target.value.replace(/[^0-9.]/g, ""))}
        onBlur={() => {
          // Leaving the field untouched must not re-save a rounded value.
          if (text === kibToMbText(value)) return;
          const mb = parseFloat(text);
          onChange(Number.isFinite(mb) && mb > 0 ? Math.round(mb * 1024) : 0);
        }}
      />
      <span className="faint small" style={{ whiteSpace: "nowrap" }}>MB/s</span>
    </div>
  );
}

type Tab = "general" | "android" | "speed" | "connection" | "privacy" | "about";

export default function Settings() {
  const { settings, saveSettings, toast, network, version, dataDir, history } = useStore();
  const [confirmClear, setConfirmClear] = useState<null | "clear" | "off">(null);
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [restartNote, setRestartNote] = useState(false);
  const [relayNote, setRelayNote] = useState(false);
  const [portNote, setPortNote] = useState(false);
  const [tab, setTab] = useState<Tab>("general");

  const storage = useStorageAccess();
  const [battery, setBattery] = useState<boolean | null>(null);
  useEffect(() => {
    if (isAndroid()) {
      const check = () => android.batteryStatus().then((b) => setBattery(b.unrestricted)).catch(() => {});
      check();
      window.addEventListener("focus", check);
      document.addEventListener("visibilitychange", check);
      return () => {
        window.removeEventListener("focus", check);
        document.removeEventListener("visibilitychange", check);
      };
    }
    isEnabled().then(setAutostart).catch(() => setAutostart(null));
  }, []);

  if (!settings) return null;
  const save = async (patch: Partial<S>) => {
    try {
      await saveSettings({ ...settings, ...patch });
    } catch (e) {
      toast(errorText(e), "err");
    }
  };
  const streamsCap = (settings.parallelStreams * 1_000_000) / 0.2; // bytes/s at 200 ms RTT

  const limitText = (kib: number) => (kib ? `${Math.max(0.01, Number((kib / 1024).toFixed(2)))} MB/s` : "Unlimited");

  return (
    <div className="desk desk-settings page-settings">
      <Win code="C0" title="Config" area="1 / 1 / 8 / 4" aria-label="Settings sections" side="Sys config" foot="Select a section" scroll={false}>
        <PlateMenu
          label="Settings sections"
          value={tab}
          onChange={setTab}
          items={[
            { id: "general" as Tab, label: "General" },
            ...(isAndroid() ? [{ id: "android" as Tab, label: "Android" }] : []),
            { id: "speed" as Tab, label: "Speed" },
            { id: "connection" as Tab, label: "Connection" },
            { id: "privacy" as Tab, label: "Privacy" },
          ]}
          footer={
            <button type="button" className={`gm-plate ${tab === "about" ? "on" : ""}`} onClick={() => setTab("about")}>
              About
            </button>
          }
        />
      </Win>
      <Win code="H7" title="This device" area="8 / 1 / 13 / 4" aria-label="This device" foot={`Bifrost ${version}`}>
        <dl className="gr-kv">
          <div>
            <dt>{isAndroid() ? "This device" : "This computer"}</dt>
            <dd>{settings.deviceName}</dd>
          </div>
          <div>
            <dt>Network</dt>
            <dd className={network?.online ? "ok-text" : "st-warn"}>{network?.online ? "Online" : "Connecting"}</dd>
          </div>
          <div>
            <dt>Route mode</dt>
            <dd>{settings.connectionMode === "direct_only" ? "Direct only" : "Direct first"}</dd>
          </div>
          <div>
            <dt>Limits down / up</dt>
            <dd>{limitText(settings.downloadLimitKbps)} / {limitText(settings.uploadLimitKbps)}</dd>
          </div>
        </dl>
        <p className="gr-para">Settings are stored only on this device.</p>
      </Win>
      {tab === "general" && (
      <Win code="C1" title="General" aria-label="General" className="gx-set" area="1 / 4 / 13 / 13" foot="Name, folders and start-up">
        <div className="settings-group">
          <Row label={isAndroid() ? "Device name" : "Computer name"} hint="Shown to devices you share with or connect to.">
            <input className="input" defaultValue={settings.deviceName} maxLength={64} onBlur={(e) => e.target.value.trim() && e.target.value !== settings.deviceName && save({ deviceName: e.target.value })} />
          </Row>
          <Row label="Default download folder">
            <div className="hstack">
              <input className="input mono" value={settings.downloadDir} readOnly />
              <Button
                onClick={async () => {
                  const p = await pickFolder("Default download folder", settings.downloadDir);
                  if (p) save({ downloadDir: p });
                }}
              >
                Change…
              </Button>
            </div>
          </Row>
          <Row
            label="Default permission for invitations"
            hint={<>What a device joining with a new invitation can do, unless you pick something else when inviting. {permissionHint(settings.defaultSharePermission)} You can change it per device on the Send page.</>}
          >
            <Segmented
              label="Default permission for invitations"
              value={settings.defaultSharePermission ?? "download"}
              onChange={(v) => save({ defaultSharePermission: v })}
              options={PERMISSION_OPTIONS}
            />
          </Row>
          {!isAndroid() && (<>
          <Toggle
            checked={!!autostart}
            disabled={autostart === null}
            label="Start Bifrost when I sign in"
            hint="Starts quietly in the tray so shared folders stay available and downloads resume after a reboot."
            onChange={async (v) => {
              try {
                if (v) await enable();
                else await disable();
                setAutostart(await isEnabled());
              } catch (e) {
                toast(errorText(e), "err");
              }
            }}
          />
          <Toggle
            checked={settings.closeToTray}
            label="Keep running in the tray when the window is closed"
            hint="Closing the window releases its memory; transfers continue. Quit from the tray icon."
            onChange={(v) => save({ closeToTray: v })}
          />
          </>)}
          <Toggle checked={settings.notifications} label="Notifications" hint="When a transfer finishes, needs attention, or a device asks for access." onChange={(v) => save({ notifications: v })} />
        </div>
      </Win>)}

      {isAndroid() && tab === "android" && (
        <Win code="C2" title="Android" aria-label="Android" className="gx-set" area="1 / 4 / 13 / 13" foot="Phone permissions">
          <div className="settings-group">
            <Row label="All files access" hint="Needed to share folders and save downloads to real folders such as Download/Bifrost.">
              {storage.granted ? (
                <span className="pill pill-ok"><FolderLock size={12} /> Allowed</span>
              ) : (
                <Button variant="primary" onClick={storage.request}>Allow</Button>
              )}
            </Row>
            <Row label="Run in the background" hint="Lets transfers continue with the screen off. Tap Allow, pick Bifrost in the list and choose “Don't optimize” or “Unrestricted”.">
              {battery ? (
                <span className="pill pill-ok"><BatteryCharging size={12} /> Unrestricted</span>
              ) : (
                <Button onClick={() => android.requestIgnoreBatteryOptimizations().then((b) => setBattery(b.unrestricted)).catch(() => {})}>Allow</Button>
              )}
            </Row>
            <Row label="Notification permission" hint="Shows transfer progress and access requests.">
              <Button icon={<Bell size={14} />} onClick={() => android.requestNotificationPermission().catch(() => {})}>Request</Button>
            </Row>
          </div>
        </Win>
      )}

      {tab === "speed" && (

      <Win code="C3" title="Speed and resources" aria-label="Speed and resources" className="gx-set" area="1 / 4 / 13 / 13" foot="Streams, limits and CPU">
        <div className="settings-group">
          <Row
            label="Parallel streams per file"
            hint={<>More streams fill long, high-latency links (like Bangladesh to Europe). {settings.parallelStreams} streams can carry about {mbit(streamsCap)} at 200 ms latency.</>}
          >
            <div className="range-field">
              <input
                type="range"
                className="range-meter"
                min={1}
                max={32}
                value={settings.parallelStreams}
                onChange={(e) => save({ parallelStreams: Number(e.target.value) })}
                aria-label="Parallel streams per file"
                style={{ ["--p" as string]: (settings.parallelStreams - 1) / 31 } as React.CSSProperties}
              />
              <span className="range-value num" aria-hidden="true">{String(settings.parallelStreams).padStart(2, "0")}</span>
            </div>
          </Row>
          <Row
            label="Connections per sender"
            hint="On long or lossy direct links, several connections carry more than one. Bifrost adds them only while each one raises the speed, and never over a relay."
          >
            <Segmented
              label="Connections per sender"
              value={settings.maxConnections ?? 8}
              onChange={(v) => save({ maxConnections: v })}
              options={[
                { value: 1, label: "1 (off)" },
                { value: 4, label: "Up to 4" },
                { value: 8, label: "Up to 8" },
              ]}
            />
          </Row>
          <Row label="Files downloading at once">
            <Segmented label="Concurrent transfers" value={settings.maxConcurrentJobs} onChange={(v) => save({ maxConcurrentJobs: v })} options={[1, 2, 3, 4].map((n) => ({ value: n, label: String(n) }))} />
          </Row>
          <Row label="Download limit" hint="Leave empty for full speed.">
            <LimitInput value={settings.downloadLimitKbps} onChange={(v) => save({ downloadLimitKbps: v })} />
          </Row>
          <Row label="Upload limit" hint="Caps how fast this computer sends, to keep the connection usable for others at home.">
            <LimitInput value={settings.uploadLimitKbps} onChange={(v) => save({ uploadLimitKbps: v })} />
          </Row>
          <Toggle
            checked={settings.lowPriority}
            disabled={isAndroid()}
            label="Yield CPU to other apps"
            hint="Runs Bifrost at below-normal priority. Network speed is unaffected; your other programs stay responsive."
            onChange={(v) => save({ lowPriority: v })}
          />
          <Row label="Congestion control" hint="CUBIC gives the steadiest speed and is recommended. BBR (experimental) can help on very lossy links but sometimes stalls at a few KB/s. Matters most on the sending computer. Applies after restarting Bifrost.">
            <Segmented
              label="Congestion control"
              value={settings.congestion}
              onChange={(v) => {
                save({ congestion: v });
                setRestartNote(true);
              }}
              options={[
                { value: "cubic", label: "CUBIC (recommended)" },
                { value: "bbr", label: "BBR (experimental)" },
              ]}
            />
          </Row>
          <Row label="Piece size for new downloads" hint="Larger pieces mean less overhead; smaller pieces lose less on each interruption.">
            <Segmented label="Piece size" value={settings.chunkSizeMib} onChange={(v) => save({ chunkSizeMib: v })} options={[8, 16, 32].map((n) => ({ value: n, label: `${n} MB` }))} />
          </Row>
        </div>
        {restartNote && (
          <div className="notice" style={{ marginTop: 10 }}>
            <Info size={16} />
            <span>Quit Bifrost from the tray and open it again to use the new congestion control.</span>
          </div>
        )}
      </Win>)}

      {tab === "connection" && (

      <Win code="C4" title="Connection" aria-label="Connection" className="gx-set" area="1 / 4 / 13 / 13" foot="Route, relay and port">
        <div className="settings-group">
          <Row
            label="Route mode"
            hint={
              settings.connectionMode === "direct_only"
                ? "File data only flows over a direct path. If routers block one (common on mobile data), transfers wait at 0 instead of using a relay."
                : "Tries a direct path first. If none opens within about 5 seconds, data goes through a public relay, still end-to-end encrypted: the relay can't read or keep it. Switches to direct as soon as possible."
            }
          >
            <Segmented
              label="Route mode"
              value={settings.connectionMode}
              onChange={(v) => save({ connectionMode: v })}
              options={[
                { value: "allow_relay", label: "Direct first (recommended)" },
                { value: "direct_only", label: "Direct only" },
              ]}
            />
          </Row>
          <Row
            label="Relay server"
            hint={
              <>
                Leave empty to use the free public relays, which are rate-limited (often around 1 Mbit/s). For fast transfers when routers block a
                direct path, run your own relay and enter its address on both devices. Setup guide: docs/RELAY.md on the Bifrost GitHub page.
              </>
            }
          >
            <input
              className="input mono"
              placeholder="relay.example.org"
              defaultValue={settings.relayUrls}
              spellCheck={false}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== settings.relayUrls) {
                  save({ relayUrls: v });
                  setRelayNote(true);
                }
              }}
            />
          </Row>
          <Row
            label="Direct connection port"
            hint={
              <>
                Bifrost receives direct connections on this UDP port. It stays the same, so routers can keep a direct path open. If transfers are
                often relayed, forward UDP port {network?.udpPort ?? settings.udpPort} to this {isAndroid() ? "device" : "computer"} in your router,
                or turn on UPnP there.
                {network?.udpPort != null && settings.udpPort !== 0 && network.udpPort !== settings.udpPort && (
                  <> Port {settings.udpPort} was taken, so Bifrost is using {network.udpPort} for now.</>
                )}
              </>
            }
          >
            <input
              className="input num mono"
              inputMode="numeric"
              aria-label="Direct connection UDP port"
              defaultValue={settings.udpPort || ""}
              onBlur={(e) => {
                const text = e.target.value.trim();
                const n = Number(text);
                if (!/^\d+$/.test(text) || n < 1024 || n > 65535) {
                  if (text !== "") toast("Use a port from 1024 to 65535.", "err");
                  e.target.value = String(settings.udpPort || "");
                  return;
                }
                if (n !== settings.udpPort) {
                  save({ udpPort: n });
                  setPortNote(true);
                }
              }}
            />
          </Row>
        </div>
        {relayNote && (
          <div className="notice" style={{ marginTop: 10 }}>
            <Info size={16} />
            <span>Quit Bifrost and open it again to use the new relay server. Set the same relay on the other device too.</span>
          </div>
        )}
        {portNote && (
          <div className="notice" style={{ marginTop: 10 }}>
            <Info size={16} />
            <span>Quit Bifrost and open it again to use the new port.</span>
          </div>
        )}
      </Win>)}

      {tab === "privacy" && (

      <Win code="C5" title="Privacy" aria-label="Privacy" className="gx-set" area="1 / 4 / 13 / 13" foot="History and map lookups">
        <div className="settings-group">
          <div className="privacy-facts">
            <Lock size={16} aria-hidden="true" />
            <span>
              Bifrost has no account and sends no analytics. Transfer history, receipts and these settings are stored only in this device's
              database. The coordination service sees that two devices want to connect, never file names or contents.
              {settings.mapLocations && " To show devices on the map, their public IP addresses are looked up at ipinfo.io."}
            </span>
          </div>
          <Toggle
            checked={settings.mapLocations}
            label="Show devices on the map"
            hint="Places this device and connected devices on the Network globe by public IP address (city level, looked up at ipinfo.io). This device's public IP is shared with paired devices for the same purpose. When off, devices get made-up spots and nothing is looked up."
            onChange={(v) => save({ mapLocations: v })}
          />
          <Row label="Keep history" hint="Finished transfers and their privacy receipts, for the History page. Older entries are deleted automatically.">
            <Segmented
              label="History retention"
              value={settings.historyRetention}
              onChange={(v) => (v === "off" && history.length > 0 ? setConfirmClear("off") : save({ historyRetention: v }))}
              options={[
                { value: "365", label: "1 year" },
                { value: "90", label: "90 days" },
                { value: "30", label: "30 days" },
                { value: "forever", label: "Forever" },
                { value: "off", label: "Off" },
              ]}
            />
          </Row>
          <Toggle
            checked={settings.historyNames}
            disabled={settings.historyRetention === "off"}
            label="Keep file names in history"
            hint="When off, new entries keep only the file type, size, device and receipt."
            onChange={(v) => save({ historyNames: v })}
          />
          <Row label="Clear history" hint={history.length ? `${history.length.toLocaleString()} finished transfer${history.length === 1 ? "" : "s"} on this device.` : "Nothing stored right now."}>
            <Button variant="danger" disabled={history.length === 0} onClick={() => setConfirmClear("clear")}>Clear history</Button>
          </Row>
        </div>
        {confirmClear && (
          <Modal
            title={confirmClear === "off" ? "Turn off history?" : "Clear history?"}
            onClose={() => setConfirmClear(null)}
            footer={
              <>
                <Button variant="ghost" onClick={() => setConfirmClear(null)}>Keep it</Button>
                <Button
                  variant="danger"
                  onClick={async () => {
                    const mode = confirmClear;
                    setConfirmClear(null);
                    try {
                      if (mode === "off") await save({ historyRetention: "off" });
                      else await api.clearHistory();
                      toast(mode === "off" ? "History is off and was deleted" : "History cleared", "ok");
                    } catch (e) {
                      toast(errorText(e), "err");
                    }
                  }}
                >
                  {confirmClear === "off" ? "Turn off and delete" : "Delete history"}
                </Button>
              </>
            }
          >
            <span>
              This deletes {history.length.toLocaleString()} receipt{history.length === 1 ? "" : "s"} and the calendar from this device. Downloaded files are not touched.
              {confirmClear === "off" && " New transfers won't be recorded until you turn history back on."}
            </span>
          </Modal>
        )}
      </Win>)}

      {tab === "about" && (

      <Win code="C6" title="About" aria-label="About" className="gx-set" area="1 / 4 / 13 / 13" foot="Identity and version">
        <div className="settings-group">
          <Row label="Device ID" hint="Your cryptographic identity. Others verify it on every connection.">
            <div className="hstack">
              <span className="mono small truncate selectable">{network?.endpointId}</span>
              <Button size="sm" icon={<Copy size={13} />} onClick={() => network && navigator.clipboard.writeText(network.endpointId)} />
            </div>
          </Row>
          <Row label="Network">
            <span className="muted small">
              {network?.online ? "Online" : "Offline"}
              {network?.relayUrl ? ` · coordination via ${new URL(network.relayUrl).hostname}` : ""}
              {network ? ` · ${network.directAddrs} local address(es)` : ""}
            </span>
          </Row>
          <Row label="Version">
            <span className="muted small">Bifrost {version}</span>
          </Row>
          <Row label="App data">
            <span className="mono small faint selectable" style={{ overflowWrap: "anywhere" }}>{dataDir}</span>
          </Row>
        </div>
      </Win>)}
    </div>
  );
}
