//! "Allow direct connections" (Windows): an inbound UDP rule for Bifrost in
//! Windows Firewall, on every network type.
//!
//! Windows asks on first launch, and that prompt quietly leaves direct
//! connections blocked when the user cancels it (a Block rule) or allows only
//! some network types (e.g. Public but not Private). Hole punching still
//! needs the computer to accept the other device's packets, so transfers then
//! fall back to the relay. This module checks for that and, once the user
//! agrees, fixes it with one administrator prompt.
//!
//! Reading rules needs no administrator rights; changing them does. Both go
//! through PowerShell's NetSecurity cmdlets, whose values aren't translated
//! on non-English Windows (unlike `netsh` output).

use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FirewallStatus {
    /// This platform has a firewall Bifrost can configure (Windows).
    pub supported: bool,
    /// An enabled inbound rule allows UDP for Bifrost on every network type.
    pub allowed: bool,
    /// Enabled inbound rules that block Bifrost (they win over allow rules).
    pub blocked: u32,
    /// The program the rules are for.
    pub program: String,
}

/// Rule group, so a later "allow" replaces earlier rules (e.g. for an old install path).
#[cfg(windows)]
const GROUP: &str = "Bifrost";

#[cfg(windows)]
fn exe() -> Result<String, String> {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("Couldn't find the Bifrost program: {e}"))
}

/// PowerShell single-quoted string literal.
#[cfg(windows)]
fn ps_str(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Runs a PowerShell script without a console window; returns its output.
#[cfg(windows)]
fn powershell(script: &str) -> Result<(i32, String), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // -EncodedCommand (UTF-16LE, base64) sidesteps all command-line quoting.
    let utf16: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let out = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"])
        .arg(data_encoding::BASE64.encode(&utf16))
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Couldn't run PowerShell: {e}"))?;
    Ok((out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout).trim().to_string()))
}

/// Enabled inbound rules for `$p` that cover UDP. Shared by the check and the fix.
#[cfg(windows)]
const RULES_FOR_PROGRAM: &str = r#"
function Get-BifrostRules($p) {
  foreach ($f in @(Get-NetFirewallApplicationFilter -ErrorAction Stop | Where-Object { $_.Program -and [Environment]::ExpandEnvironmentVariables($_.Program) -ieq $p })) {
    $r = $f | Get-NetFirewallRule
    if ("$($r.Enabled)" -ne 'True' -or "$($r.Direction)" -ne 'Inbound') { continue }
    $proto = "$(($r | Get-NetFirewallPortFilter).Protocol)"
    if ($proto -ne 'UDP' -and $proto -ne 'Any') { continue }
    $r
  }
}
"#;

#[cfg(windows)]
pub fn status() -> Result<FirewallStatus, String> {
    let program = exe()?;
    let script = format!(
        r#"$ErrorActionPreference = 'Stop'
{RULES_FOR_PROGRAM}
$allow = $false; $block = 0
foreach ($r in @(Get-BifrostRules {p})) {{
  $prof = "$($r.Profile)"
  if ("$($r.Action)" -eq 'Block') {{ $block++ }}
  elseif ($prof -eq 'Any' -or ($prof -match 'Domain' -and $prof -match 'Private' -and $prof -match 'Public')) {{ $allow = $true }}
}}
Write-Output ("{{0}} {{1}}" -f [int]$allow, $block)"#,
        p = ps_str(&program)
    );
    let (code, out) = powershell(&script)?;
    let mut it = out.lines().last().unwrap_or("").split_whitespace();
    match (code, it.next(), it.next().and_then(|b| b.parse::<u32>().ok())) {
        (0, Some(a), Some(blocked)) => Ok(FirewallStatus { supported: true, allowed: a == "1" && blocked == 0, blocked, program }),
        _ => Err("Couldn't read the Windows Firewall rules.".into()),
    }
}

/// Asks for administrator rights once (the Windows UAC prompt), then removes
/// rules that block Bifrost and adds one inbound UDP allow rule for every
/// network type. Returns the new status.
#[cfg(windows)]
pub fn allow() -> Result<FirewallStatus, String> {
    let elevated = allow_script(&exe()?);
    let utf16: Vec<u8> = elevated.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let b64 = data_encoding::BASE64.encode(&utf16);
    // The outer, normal PowerShell starts the elevated one and waits for it.
    // Cancelling the UAC prompt makes Start-Process throw: exit 2.
    let launcher = format!(
        r#"try {{
  $x = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','{b64}'
  exit $x.ExitCode
}} catch {{ exit 2 }}"#
    );
    match powershell(&launcher)?.0 {
        0 => status(),
        2 => Err("Windows didn't give permission, so nothing was changed.".into()),
        _ => Err("Windows Firewall didn't accept the change.".into()),
    }
}

/// The script that runs with administrator rights.
#[cfg(windows)]
fn allow_script(program: &str) -> String {
    format!(
        r#"$ErrorActionPreference = 'Stop'
try {{
{RULES_FOR_PROGRAM}
  $p = {p}
  Get-BifrostRules $p | Where-Object {{ "$($_.Action)" -eq 'Block' }} | Remove-NetFirewallRule
  Get-NetFirewallRule -Group {g} -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName 'Bifrost (direct connections)' -Group {g} -Description 'Lets other devices reach Bifrost directly instead of through a relay.' -Direction Inbound -Action Allow -Program $p -Protocol UDP -Profile Any | Out-Null
  exit 0
}} catch {{ exit 1 }}"#,
        p = ps_str(program),
        g = ps_str(GROUP)
    )
}

#[cfg(not(windows))]
pub fn status() -> Result<FirewallStatus, String> {
    Ok(FirewallStatus { supported: false, allowed: false, blocked: 0, program: String::new() })
}

#[cfg(not(windows))]
pub fn allow() -> Result<FirewallStatus, String> {
    Err("Only needed on Windows.".into())
}

#[cfg(all(test, windows))]
mod tests {
    /// Reads the real firewall (no changes). `cargo test -p bifrost firewall -- --ignored`
    #[test]
    #[ignore]
    fn status_reads_rules() {
        let s = super::status().expect("status");
        assert!(s.supported);
        println!("{s:?}");
    }

    /// The administrator script parses (it isn't run). Uses a path with a quote.
    #[test]
    fn allow_script_parses() {
        let script = super::allow_script(r"C:\Users\O'Neil\AppData\Local\Bifrost\Bifrost.exe");
        let check = format!(
            "$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput({}, [ref]$null, [ref]$e); if ($e.Count) {{ $e | ForEach-Object {{ $_.Message }}; exit 1 }}",
            super::ps_str(&script)
        );
        let (code, out) = super::powershell(&check).expect("powershell");
        assert_eq!(code, 0, "{out}");
    }
}
